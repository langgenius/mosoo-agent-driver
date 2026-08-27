import { parseCmaInboundEvent, projectCmaInboundToDriverCommand } from "../../projections/cma";
import { isDriverId } from "../../protocol/id";
import type { RuntimeCommandResult } from "../../runtime-command";
import type { CmaInboundEventLease, CmaSessionEventRecord, CmaStore } from "../../stores/cma-store";
import { encodeCmaSseRecord } from "../../stores/cma-store";
import { sleepPromise } from "../../utils/async";
import {
  CmaHttpDriverDispatchError,
  CmaHttpRequestError,
  type CmaHttpDriverCommandDispatcher,
} from "./contract";
import { readCmaJsonBody } from "./request";
import { createDataResponse, createErrorResponse } from "./response";

function keepClaimAlive(
  store: CmaStore,
  sessionId: string,
  commandId: string,
  initialLease: CmaInboundEventLease,
): { readonly signal: AbortSignal; stop(): void } {
  const stopped = new AbortController();
  const failed = new AbortController();

  void (async () => {
    let lease = initialLease;

    while (!stopped.signal.aborted) {
      await sleepPromise(
        Math.max(1_000, Date.parse(lease.renewAfter) - Date.now()),
        stopped.signal,
      );
      lease = await store.renewInboundEventClaim({
        commandId,
        leaseId: lease.id,
        sessionId,
      });
    }
  })().catch((error: unknown) => {
    if (!stopped.signal.aborted) {
      failed.abort(error);
    }
  });

  return {
    signal: failed.signal,
    stop: () => stopped.abort(),
  };
}

export async function handleGetSessionEvents(
  request: Request,
  sessionId: string,
  store: CmaStore,
): Promise<Response> {
  const session = await store.getSession(sessionId);

  if (!session) {
    return createErrorResponse(404, "CMA_SESSION_NOT_FOUND", "Session was not found.");
  }

  if (request.headers.get("accept")?.includes("text/event-stream") === true) {
    const afterCursor = request.headers.get("last-event-id")?.trim();

    if (afterCursor !== undefined && afterCursor.length > 0 && !isDriverId(afterCursor)) {
      throw new CmaHttpRequestError(
        400,
        "CMA_INVALID_LAST_EVENT_ID",
        "Last-Event-ID must be a ULID.",
      );
    }

    return createCmaSseResponse(
      store.streamSessionEvents(
        sessionId,
        afterCursor === undefined || afterCursor.length === 0 ? undefined : afterCursor,
      ),
    );
  }

  return createDataResponse(await store.listSessionEvents(sessionId));
}

export async function handlePostSessionEvent(
  request: Request,
  sessionId: string,
  store: CmaStore,
  dispatchDriverCommand: CmaHttpDriverCommandDispatcher,
): Promise<Response> {
  const session = await store.getSession(sessionId);

  if (!session) {
    return createErrorResponse(404, "CMA_SESSION_NOT_FOUND", "Session was not found.");
  }

  const body = await readCmaJsonBody(request);
  const event = parseCmaInboundEvent(body);
  const command = projectCmaInboundToDriverCommand(event);
  const claim = await store.claimInboundEvent({
    command,
    event,
    sessionId,
  });

  if (!claim.claimed) {
    if (claim.event.commandStatus === "failed") {
      throw new CmaHttpDriverDispatchError();
    }

    return createDataResponse(
      {
        command,
        event: claim.event,
        result: claim.event.commandResult,
        status: "accepted",
      },
      202,
    );
  }

  const keeper = keepClaimAlive(store, sessionId, command.commandId, claim.lease);
  const signal = AbortSignal.any([request.signal, keeper.signal]);

  try {
    let commandResult: RuntimeCommandResult | null;

    try {
      signal.throwIfAborted();
      commandResult = (await dispatchDriverCommand({ command, event, session, signal })) ?? null;
    } catch {
      if (!keeper.signal.aborted) {
        await store
          .settleInboundEvent({
            commandId: command.commandId,
            commandResult: null,
            leaseId: claim.lease.id,
            sessionId,
            status: "failed",
          })
          .catch(() => undefined);
      }
      throw new CmaHttpDriverDispatchError();
    }

    const record = await store.settleInboundEvent({
      commandId: command.commandId,
      commandResult,
      leaseId: claim.lease.id,
      sessionId,
      status: "completed",
    });

    return createDataResponse(
      {
        command,
        event: record,
        result: commandResult,
        status: "accepted",
      },
      202,
    );
  } finally {
    keeper.stop();
  }
}

function createCmaSseResponse(events: AsyncIterable<CmaSessionEventRecord>): Response {
  let cleanupPromise: Promise<void> | undefined;
  let iterator: AsyncIterator<CmaSessionEventRecord> | undefined;
  const cleanup = () =>
    (cleanupPromise ??= (async () => {
      await iterator?.return?.();
    })());

  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          iterator ??= events[Symbol.asyncIterator]();
          const result = await iterator.next();

          if (result.done) {
            await cleanup();
            controller.close();
            return;
          }

          controller.enqueue(encodeCmaSseRecord(result.value));
        } catch (error) {
          await cleanup().catch(() => undefined);
          controller.error(error);
        }
      },
      async cancel() {
        await cleanup();
      },
    },
    { highWaterMark: 0 },
  );

  return new Response(body, {
    headers: {
      "cache-control": "no-cache",
      "content-type": "text/event-stream; charset=utf-8",
    },
    status: 200,
  });
}
