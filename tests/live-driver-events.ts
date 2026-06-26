import type { DriverEventInput } from "../src/protocol/events";

export type LiveStatusDetails = Record<string, boolean | number | string>;
export type LiveStatusLogger = (message: string, details?: LiveStatusDetails) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function eventPayload(event: DriverEventInput): Record<string, unknown> | null {
  return isRecord(event.payload) ? event.payload : null;
}

export function textDeltaFrom(event: DriverEventInput): string {
  if (event.kind !== "message.delta") {
    return "";
  }

  const contentDelta = eventPayload(event)?.["contentDelta"];
  return typeof contentDelta === "string" ? contentDelta : "";
}

function errorMessageFrom(event: DriverEventInput): string {
  const error = eventPayload(event)?.["error"];

  if (!isRecord(error)) {
    return "unknown provider error";
  }

  const code = typeof error["code"] === "string" ? error["code"] : "unknown";
  const message = typeof error["message"] === "string" ? error["message"] : "unknown";
  return `${code}: ${message}`;
}

function describeCollectedKinds(events: readonly DriverEventInput[]): string {
  return events.map((event) => event.kind).join(", ");
}

export async function waitForTerminalTurnEvent(input: {
  events: AsyncIterable<DriverEventInput>;
  logStatus?: LiveStatusLogger;
  progressMessage?: string;
  timeoutMs: number;
}): Promise<DriverEventInput[]> {
  const collected: DriverEventInput[] = [];
  const iterator = input.events[Symbol.asyncIterator]();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let progressId: ReturnType<typeof setInterval> | null = null;
  let lastEventKind = "none";
  let messageDeltaChars = 0;
  const startedAtMs = Date.now();
  const timeout = new Promise<"timeout">((resolve) => {
    timeoutId = setTimeout(() => resolve("timeout"), input.timeoutMs);
  });

  if (input.logStatus) {
    progressId = setInterval(() => {
      input.logStatus?.(input.progressMessage ?? "waiting for terminal event", {
        elapsedMs: Date.now() - startedAtMs,
        events: collected.length,
        lastEventKind,
        messageDeltaChars,
      });
    }, 10_000);
  }

  try {
    while (true) {
      const result = await Promise.race([iterator.next(), timeout]);

      if (result === "timeout") {
        throw new Error(
          `Timed out waiting for live driver turn. Collected events: ${describeCollectedKinds(
            collected,
          )}`,
        );
      }

      if (result.done) {
        throw new Error(
          `Driver event stream closed before live turn completed. Collected events: ${describeCollectedKinds(
            collected,
          )}`,
        );
      }

      collected.push(result.value);
      lastEventKind = result.value.kind;

      if (result.value.kind === "message.delta") {
        messageDeltaChars += textDeltaFrom(result.value).length;
      }

      input.logStatus?.("received event", {
        count: collected.length,
        kind: result.value.kind,
        messageDeltaChars,
      });

      if (result.value.kind === "run.failed") {
        throw new Error(`Live driver turn failed: ${errorMessageFrom(result.value)}`);
      }

      if (result.value.kind === "run.completed") {
        input.logStatus?.("terminal event received", {
          elapsedMs: Date.now() - startedAtMs,
          events: collected.length,
          messageDeltaChars,
        });
        return collected;
      }
    }
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    if (progressId) {
      clearInterval(progressId);
    }
  }
}

export async function withLiveTimeout<T>(input: {
  details: LiveStatusDetails;
  label: string;
  logStatus: LiveStatusLogger;
  task: () => Promise<T>;
  timeoutMs: number;
}): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let progressId: ReturnType<typeof setInterval> | null = null;
  const startedAtMs = Date.now();
  const timeout = new Promise<"timeout">((resolve) => {
    timeoutId = setTimeout(() => resolve("timeout"), input.timeoutMs);
  });
  progressId = setInterval(() => {
    input.logStatus(`waiting for ${input.label}`, {
      ...input.details,
      elapsedMs: Date.now() - startedAtMs,
    });
  }, 10_000);

  try {
    const result = await Promise.race([input.task(), timeout]);

    if (result === "timeout") {
      throw new Error(
        `Timed out waiting for ${input.label}. ${JSON.stringify(
          Object.fromEntries(
            Object.entries(input.details).toSorted((a, b) => a[0].localeCompare(b[0])),
          ),
        )}`,
      );
    }

    return result;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    if (progressId) {
      clearInterval(progressId);
    }
  }
}
