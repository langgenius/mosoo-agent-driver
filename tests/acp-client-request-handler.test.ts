import { describe, expect, test } from "bun:test";

import {
  DriverPermissionBroker,
  PermissionEventDeliveryError,
  type DriverPermissionRequest,
} from "../src/core/driver-permission-broker";
import type { DriverRuntimeEventPort } from "../src/core/driver-runtime-io";
import { AcpClientRequestHandler } from "../src/runtimes/acp/acp-client-request-handler";
import { AcpTurnEventState } from "../src/runtimes/acp/acp-event-translator";

describe("ACP client request handler", () => {
  test("rejects permission requests outside an active turn", async () => {
    let permissionRequests = 0;
    let pushes = 0;
    const handler = new AcpClientRequestHandler({
      allowedRoots: [],
      cwd: "/workspace",
      env: {},
      isCancelling: () => false,
      nativeSessionId: () => "native-session-1",
      onUpdateFailure: () => {},
      push: async () => {
        pushes += 1;
      },
      turnEvents: new AcpTurnEventState(),
    });
    const context = {
      ports: {
        permission: {
          request: async () => {
            permissionRequests += 1;
            return "allow_once" as const;
          },
        },
      },
    } as never;

    await expect(
      handler.requestPermission(context, 1, {
        options: [{ kind: "allow_once", name: "Allow", optionId: "allow" }],
        sessionId: "native-session-1",
        toolCall: { title: "Run command", toolCallId: "tool-1" },
      }),
    ).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    await handler.drainPermissions();

    expect(permissionRequests).toBe(0);
    expect(pushes).toBe(0);
  });

  test("closes permission ingress before a turn terminal and reopens it for the next turn", async () => {
    const turnEvents = new AcpTurnEventState();
    let permissionRequests = 0;
    turnEvents.begin({
      messageId: "message-1" as never,
      runId: "run-1" as never,
      sessionId: "native-session-1",
    });
    const handler = new AcpClientRequestHandler({
      allowedRoots: [],
      cwd: "/workspace",
      env: {},
      isCancelling: () => false,
      nativeSessionId: () => "native-session-1",
      onUpdateFailure: () => {},
      push: async () => {},
      turnEvents,
    });
    const context = {
      ports: {
        permission: {
          request: async () => {
            permissionRequests += 1;
            return "allow_once" as const;
          },
        },
      },
    } as never;
    const request = () =>
      handler.requestPermission(context, 1, {
        options: [{ kind: "allow_once", name: "Allow", optionId: "allow" }],
        sessionId: "native-session-1",
        toolCall: { title: "Run command", toolCallId: "tool-1" },
      });

    handler.closePermissionIngress();
    await expect(request()).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    handler.openPermissionIngress();
    await expect(request()).resolves.toEqual({
      outcome: { optionId: "allow", outcome: "selected" },
    });
    expect(permissionRequests).toBe(1);
  });

  test("suppresses turn-scoped session updates before a turn is active", async () => {
    const pushedReasons: string[] = [];
    const handler = new AcpClientRequestHandler({
      allowedRoots: [],
      cwd: "/workspace",
      env: {},
      isCancelling: () => false,
      nativeSessionId: () => "native-session-1",
      onUpdateFailure: () => {},
      push: async (_context, reason, _events) => {
        pushedReasons.push(reason);
      },
      turnEvents: new AcpTurnEventState(),
    });

    for (const replaying of [false, true]) {
      const sendUpdate = async () => {
        await handler.enqueueUpdate({} as never, {
          sessionId: "native-session-1",
          update: {
            content: {
              text: "replayed assistant text",
              type: "text",
            },
            sessionUpdate: "agent_message_chunk",
          },
        });
      };

      if (replaying) {
        await handler.withSessionReplay(sendUpdate);
      } else {
        await sendUpdate();
      }
    }

    expect(pushedReasons).toEqual([]);
  });

  test("discards deferred updates and permits a later gate", async () => {
    const pushedReasons: string[] = [];
    const handler = new AcpClientRequestHandler({
      allowedRoots: [],
      cwd: "/workspace",
      env: {},
      isCancelling: () => false,
      nativeSessionId: () => "native-session-1",
      onUpdateFailure: () => {},
      push: async (_context, reason) => {
        pushedReasons.push(reason);
      },
      turnEvents: new AcpTurnEventState(),
    });
    const notification = {
      sessionId: "native-session-1",
      update: {
        availableCommands: [{ description: "Early command", name: "early" }],
        sessionUpdate: "available_commands_update" as const,
      },
    };

    const discarded = handler.deferUpdates();
    const droppedUpdate = handler.enqueueUpdate({} as never, notification);
    discarded.discard();
    await droppedUpdate;

    const committed = handler.deferUpdates();
    const appliedUpdate = handler.enqueueUpdate({} as never, notification);
    committed.commit();
    await appliedUpdate;

    expect(pushedReasons).toEqual(["driver.acp.session.update"]);
  });

  test("passes the runtime environment to terminal child processes", async () => {
    const handler = new AcpClientRequestHandler({
      allowedRoots: [],
      cwd: process.cwd(),
      env: { PATH: "/artifact/bin:/runtime/bin" },
      isCancelling: () => false,
      nativeSessionId: () => "native-session-1",
      onUpdateFailure: () => {},
      push: async () => {},
      turnEvents: new AcpTurnEventState(),
    });
    const context = {} as never;
    const { terminalId } = await handler.createTerminal(context, {
      args: ["-e", "process.stdout.write(process.env.PATH ?? '')"],
      command: process.execPath,
      env: [],
      sessionId: "native-session-1",
    });

    await handler.waitForTerminalExit({ sessionId: "native-session-1", terminalId });

    expect(handler.terminalOutput({ sessionId: "native-session-1", terminalId }).output).toBe(
      "/artifact/bin:/runtime/bin",
    );
    await handler.releaseTerminal(context, { sessionId: "native-session-1", terminalId });
  });

  test("serializes official SDK notifications and drains scoped suppression", async () => {
    const gate = Promise.withResolvers<void>();
    const pushedReasons: string[] = [];
    const turnEvents = new AcpTurnEventState();
    turnEvents.begin({
      messageId: "message-1" as never,
      runId: "run-1" as never,
      sessionId: "native-session-1",
    });
    const handler = new AcpClientRequestHandler({
      allowedRoots: [],
      cwd: "/workspace",
      env: {},
      isCancelling: () => false,
      nativeSessionId: () => "native-session-1",
      onUpdateFailure: () => {},
      push: async (_context, reason) => {
        pushedReasons.push(reason);
        if (pushedReasons.length === 1) {
          await gate.promise;
        }
      },
      turnEvents,
    });
    const update = (text: string) =>
      handler.enqueueUpdate({} as never, {
        sessionId: "native-session-1",
        update: {
          content: { text, type: "text" },
          messageId: text,
          sessionUpdate: "agent_message_chunk",
        },
      });
    const first = update("first");
    const second = update("second");
    await Promise.resolve();
    await Promise.resolve();
    expect(pushedReasons).toHaveLength(1);

    gate.resolve();
    await Promise.all([first, second]);
    expect(pushedReasons).toHaveLength(2);

    const draining = handler.drainUpdates();
    let late = Promise.resolve();
    queueMicrotask(() => {
      late = update("late");
    });
    await draining;
    await late;
    expect(pushedReasons).toHaveLength(3);

    pushedReasons.length = 0;
    let suppressed: Promise<void> | undefined;
    await handler.suppressUpdates(async () => {
      suppressed = update("hidden");
      await handler.enqueueUpdate({} as never, {
        sessionId: "native-session-1",
        update: { sessionUpdate: "usage_update", size: 10, used: 1 },
      });
    });
    await suppressed;
    expect(pushedReasons).toEqual(["driver.acp.session.update"]);
  });

  test("fails every queued update after the first commit failure", async () => {
    const failures: Error[] = [];
    let pushes = 0;
    const turnEvents = new AcpTurnEventState();
    turnEvents.begin({
      messageId: "message-1" as never,
      runId: "run-1" as never,
      sessionId: "native-session-1",
    });
    const handler = new AcpClientRequestHandler({
      allowedRoots: [],
      cwd: "/workspace",
      env: {},
      isCancelling: () => false,
      nativeSessionId: () => "native-session-1",
      onUpdateFailure: (error) => failures.push(error),
      push: async () => {
        pushes += 1;

        if (pushes === 1) {
          throw new Error("authority unavailable");
        }
      },
      turnEvents,
    });
    const update = (text: string) =>
      handler.enqueueUpdate({} as never, {
        sessionId: "native-session-1",
        update: {
          content: { text, type: "text" },
          messageId: text,
          sessionUpdate: "agent_message_chunk",
        },
      });
    const settled = await Promise.allSettled([update("first"), update("second")]);

    expect(settled.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(
      settled.map((result) =>
        result.status === "rejected" ? (result.reason as Error).message : null,
      ),
    ).toEqual(["authority unavailable", "authority unavailable"]);
    await expect(handler.drainUpdates()).rejects.toThrow("authority unavailable");
    expect(pushes).toBe(1);
    expect(failures).toHaveLength(1);
  });

  test.each(["update drain", "tool event"] as const)(
    "cancels a permission request while waiting on the %s boundary",
    async (boundary) => {
      const blocked = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const turnEvents = new AcpTurnEventState();
      let cancelling = false;
      let permissionRequests = 0;
      turnEvents.begin({
        messageId: "message-1" as never,
        runId: "run-1" as never,
        sessionId: "native-session-1",
      });
      const blockedReason =
        boundary === "update drain" ? "driver.acp.session.update" : "driver.acp.permission.tool";
      const handler = new AcpClientRequestHandler({
        allowedRoots: [],
        cwd: "/workspace",
        env: {},
        isCancelling: () => cancelling,
        nativeSessionId: () => "native-session-1",
        onUpdateFailure: () => {},
        push: async (_context, reason) => {
          if (reason === blockedReason) {
            blocked.resolve();
            await release.promise;
          }
        },
        turnEvents,
      });
      const context = {
        ports: {
          permission: {
            request: async () => {
              permissionRequests += 1;
              return "allow_once" as const;
            },
          },
        },
      } as never;
      const update =
        boundary === "update drain"
          ? handler.enqueueUpdate(context, {
              sessionId: "native-session-1",
              update: {
                content: { text: "before permission", type: "text" },
                messageId: "message-1",
                sessionUpdate: "agent_message_chunk",
              },
            })
          : Promise.resolve();
      const permission = handler.requestPermission(context, 1, {
        options: [{ kind: "allow_once", name: "Allow", optionId: "allow" }],
        sessionId: "native-session-1",
        toolCall: { title: "Run command", toolCallId: "tool-1" },
      });

      await blocked.promise;
      cancelling = true;
      release.resolve();

      await expect(permission).resolves.toEqual({ outcome: { outcome: "cancelled" } });
      await update;
      expect(permissionRequests).toBe(0);
    },
  );

  test("rejects a permission when its turn ends during the update drain", async () => {
    const updatePublishing = Promise.withResolvers<void>();
    const releaseUpdate = Promise.withResolvers<void>();
    const turnEvents = new AcpTurnEventState();
    let permissionRequests = 0;
    turnEvents.begin({
      messageId: "message-1" as never,
      runId: "run-1" as never,
      sessionId: "native-session-1",
    });
    const handler = new AcpClientRequestHandler({
      allowedRoots: [],
      cwd: "/workspace",
      env: {},
      isCancelling: () => false,
      nativeSessionId: () => "native-session-1",
      onUpdateFailure: () => {},
      push: async (_context, reason) => {
        if (reason === "driver.acp.session.update") {
          updatePublishing.resolve();
          await releaseUpdate.promise;
        }
      },
      turnEvents,
    });
    const context = {
      ports: {
        permission: {
          request: async () => {
            permissionRequests += 1;
            return "allow_once" as const;
          },
        },
      },
    } as never;
    const update = handler.enqueueUpdate(context, {
      sessionId: "native-session-1",
      update: {
        content: { text: "before permission", type: "text" },
        messageId: "message-1",
        sessionUpdate: "agent_message_chunk",
      },
    });
    const permission = handler.requestPermission(context, 1, {
      options: [{ kind: "allow_once", name: "Allow", optionId: "allow" }],
      sessionId: "native-session-1",
      toolCall: { title: "Run command", toolCallId: "tool-1" },
    });

    await updatePublishing.promise;
    turnEvents.clear();
    releaseUpdate.resolve();

    await expect(permission).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    await update;
    await handler.drainPermissions();
    expect(permissionRequests).toBe(0);
  });

  test("leaves permission lifecycle events to the host port and keeps typed RPC IDs distinct", async () => {
    const eventKinds: string[] = [];
    const requestIds: string[] = [];
    const turnEvents = new AcpTurnEventState();
    turnEvents.begin({
      messageId: "message-1" as never,
      runId: "run-1" as never,
      sessionId: "native-session-1",
    });
    const handler = new AcpClientRequestHandler({
      allowedRoots: [],
      cwd: "/workspace",
      env: {},
      isCancelling: () => false,
      nativeSessionId: () => "native-session-1",
      onUpdateFailure: () => {},
      push: async (_context, _reason, events) => {
        eventKinds.push(...events.map((event) => event.kind));
      },
      turnEvents,
    });
    const context = {
      ports: {
        permission: {
          request: async ({ requestId }: { requestId: string }) => {
            requestIds.push(requestId);
            return "allow_once" as const;
          },
        },
      },
    } as never;

    for (const [index, requestId] of [1, "1", null].entries()) {
      await expect(
        handler.requestPermission(context, requestId, {
          options: [{ kind: "allow_once", name: "Allow", optionId: "allow" }],
          sessionId: "native-session-1",
          toolCall: { title: "Run command", toolCallId: `tool-${index}` },
        }),
      ).resolves.toEqual({ outcome: { optionId: "allow", outcome: "selected" } });
    }

    expect(requestIds).toEqual(["number:1", "string:1", "null"]);
    expect(eventKinds).not.toContain("permission.requested");
    expect(eventKinds).not.toContain("permission.resolved");
  });

  test.each([
    ["allow_once", "allow_once", "allow", true],
    ["allow_once", "allow_always", "allow-session", false],
    ["reject_once", "reject_once", "reject", true],
    ["reject_once", "reject_always", "reject-session", false],
  ] as const)(
    "maps a %s host decision to a %s option without widening scope",
    async (decision, optionKind, optionId, selectable) => {
      const turnEvents = new AcpTurnEventState();
      turnEvents.begin({
        messageId: "message-1" as never,
        runId: "run-1" as never,
        sessionId: "native-session-1",
      });
      const handler = new AcpClientRequestHandler({
        allowedRoots: [],
        cwd: "/workspace",
        env: {},
        isCancelling: () => false,
        nativeSessionId: () => "native-session-1",
        onUpdateFailure: () => {},
        push: async () => {},
        turnEvents,
      });
      const context = {
        ports: { permission: { request: async () => decision } },
      } as never;

      await expect(
        handler.requestPermission(context, 1, {
          options: [{ kind: optionKind, name: "Decision", optionId }],
          sessionId: "native-session-1",
          toolCall: { title: "Run command", toolCallId: "tool-1" },
        }),
      ).resolves.toEqual(
        selectable
          ? { outcome: { optionId, outcome: "selected" } }
          : { outcome: { outcome: "cancelled" } },
      );
    },
  );

  test("returns cancelled when the SDK aborts a pending permission request", async () => {
    const entered = Promise.withResolvers<void>();
    const controller = new AbortController();
    const turnEvents = new AcpTurnEventState();
    turnEvents.begin({
      messageId: "message-1" as never,
      runId: "run-1" as never,
      sessionId: "native-session-1",
    });
    const handler = new AcpClientRequestHandler({
      allowedRoots: [],
      cwd: "/workspace",
      env: {},
      isCancelling: () => false,
      nativeSessionId: () => "native-session-1",
      onUpdateFailure: () => {},
      push: async () => {},
      turnEvents,
    });
    const context = {
      ports: {
        permission: {
          request: async (_input: unknown, signal?: AbortSignal) => {
            expect(signal).toBe(controller.signal);
            entered.resolve();
            return await new Promise<"allow_once">(() => {});
          },
        },
      },
    } as never;
    const permission = handler.requestPermission(
      context,
      1,
      {
        options: [{ kind: "allow_once", name: "Allow", optionId: "allow" }],
        sessionId: "native-session-1",
        toolCall: { title: "Run command", toolCallId: "tool-1" },
      },
      controller.signal,
    );

    await entered.promise;
    controller.abort();

    await expect(permission).resolves.toEqual({ outcome: { outcome: "cancelled" } });
  });

  test("drains a permission tool publication abandoned by request cancellation", async () => {
    const toolPublishing = Promise.withResolvers<void>();
    const releaseTool = Promise.withResolvers<void>();
    const controller = new AbortController();
    const turnEvents = new AcpTurnEventState();
    let permissionRequests = 0;
    turnEvents.begin({
      messageId: "message-1" as never,
      runId: "run-1" as never,
      sessionId: "native-session-1",
    });
    const handler = new AcpClientRequestHandler({
      allowedRoots: [],
      cwd: "/workspace",
      env: {},
      isCancelling: () => false,
      nativeSessionId: () => "native-session-1",
      onUpdateFailure: () => {},
      push: async (_context, reason) => {
        if (reason === "driver.acp.permission.tool") {
          toolPublishing.resolve();
          await releaseTool.promise;
        }
      },
      turnEvents,
    });
    const context = {
      ports: {
        permission: {
          request: async () => {
            permissionRequests += 1;
            return "allow_once" as const;
          },
        },
      },
    } as never;
    const permission = handler.requestPermission(
      context,
      1,
      {
        options: [{ kind: "allow_once", name: "Allow", optionId: "allow" }],
        sessionId: "native-session-1",
        toolCall: { title: "Run command", toolCallId: "tool-1" },
      },
      controller.signal,
    );

    await toolPublishing.promise;
    controller.abort();
    await expect(permission).resolves.toEqual({ outcome: { outcome: "cancelled" } });

    const drainCancellation = new AbortController();
    const interruptedDrain = handler.drainPermissions(drainCancellation.signal);
    drainCancellation.abort(new Error("cancelled drain"));
    await expect(interruptedDrain).rejects.toThrow("cancelled drain");
    const drained = handler.drainPermissions();
    expect(await Promise.race([drained.then(() => true), Bun.sleep(10).then(() => false)])).toBe(
      false,
    );
    releaseTool.resolve();
    await drained;
    expect(permissionRequests).toBe(0);
  });

  test("retains a settled permission delivery failure until a drain consumes it", async () => {
    const deliveryFailure = new PermissionEventDeliveryError(
      "number:1",
      "resolved",
      new Error("permission transport unavailable"),
    );
    const turnEvents = new AcpTurnEventState();
    turnEvents.begin({
      messageId: "message-1" as never,
      runId: "run-1" as never,
      sessionId: "native-session-1",
    });
    const handler = new AcpClientRequestHandler({
      allowedRoots: [],
      cwd: "/workspace",
      env: {},
      isCancelling: () => false,
      nativeSessionId: () => "native-session-1",
      onUpdateFailure: () => {},
      push: async () => {},
      turnEvents,
    });
    const context = {
      ports: {
        permission: {
          request: async () => {
            throw deliveryFailure;
          },
        },
      },
    } as never;

    await expect(
      handler.requestPermission(context, 1, {
        options: [{ kind: "allow_once", name: "Allow", optionId: "allow" }],
        sessionId: "native-session-1",
        toolCall: { title: "Run command", toolCallId: "tool-1" },
      }),
    ).rejects.toBe(deliveryFailure);
    await Promise.resolve();

    await expect(handler.drainPermissions()).rejects.toBe(deliveryFailure);
    await expect(handler.drainPermissions()).resolves.toBeUndefined();
  });

  test("keeps a late cancelled permission resolution on its originating run", async () => {
    const requestedPublishing = Promise.withResolvers<void>();
    const releaseRequested = Promise.withResolvers<void>();
    let activeRunId = "run-1";
    let resolvedRunId: string | null = null;
    const order: string[] = [];
    const socket: DriverRuntimeEventPort = {
      currentRunId: () => activeRunId as never,
      pushEvents: async ({ events }) => {
        if (events.some((event) => event.kind === "permission.requested")) {
          requestedPublishing.resolve();
          await releaseRequested.promise;
        }
        const resolved = events.find((event) => event.kind === "permission.resolved");
        if (resolved !== undefined) {
          resolvedRunId = resolved.runId ?? activeRunId;
          order.push("permission.resolved");
        }

        return {
          accepted: events.map((event, index) => ({
            seq: index + 1,
            type: event.kind,
          })),
        };
      },
    };
    const broker = new DriverPermissionBroker(() => null, {
      eventDeliveryTimeoutMs: 1_000,
    });
    const turnEvents = new AcpTurnEventState();
    turnEvents.begin({
      messageId: "message-1" as never,
      runId: activeRunId as never,
      sessionId: "native-session-1",
    });
    const handler = new AcpClientRequestHandler({
      allowedRoots: [],
      cwd: "/workspace",
      env: {},
      isCancelling: () => false,
      nativeSessionId: () => "native-session-1",
      onUpdateFailure: () => {},
      push: async () => {},
      turnEvents,
    });
    const context = {
      ports: {
        permission: {
          request: (input: DriverPermissionRequest, signal?: AbortSignal) =>
            broker.request(socket, input, signal),
        },
      },
    } as never;
    const controller = new AbortController();
    const permission = handler.requestPermission(
      context,
      1,
      {
        options: [{ kind: "allow_once", name: "Allow", optionId: "allow" }],
        sessionId: "native-session-1",
        toolCall: { title: "Run command", toolCallId: "tool-1" },
      },
      controller.signal,
    );

    await requestedPublishing.promise;
    controller.abort();
    await expect(permission).resolves.toEqual({ outcome: { outcome: "cancelled" } });

    const drained = handler.drainPermissions().then(() => {
      order.push("run.cancelled");
    });
    expect(await Promise.race([drained.then(() => true), Bun.sleep(10).then(() => false)])).toBe(
      false,
    );
    activeRunId = "run-2";
    releaseRequested.resolve();
    await drained;

    expect(resolvedRunId).toBe("run-1");
    expect(order).toEqual(["permission.resolved", "run.cancelled"]);
  });

  test("closes update ingress and drains accepted work before stopping", async () => {
    const blocked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const turnEvents = new AcpTurnEventState();
    turnEvents.begin({
      messageId: "message-1" as never,
      runId: "run-1" as never,
      sessionId: "native-session-1",
    });
    const handler = new AcpClientRequestHandler({
      allowedRoots: [],
      cwd: "/workspace",
      env: {},
      isCancelling: () => false,
      nativeSessionId: () => "native-session-1",
      onUpdateFailure: () => {},
      push: async (_context, reason) => {
        if (reason === "driver.acp.session.update") {
          blocked.resolve();
          await release.promise;
        }
      },
      turnEvents,
    });
    const update = handler.enqueueUpdate({} as never, {
      sessionId: "native-session-1",
      update: {
        content: { text: "accepted", type: "text" },
        messageId: "message-1",
        sessionUpdate: "agent_message_chunk",
      },
    });
    await blocked.promise;
    const stop = handler.closeUpdates();

    await expect(
      handler.enqueueUpdate({} as never, {
        sessionId: "native-session-1",
        update: {
          content: { text: "late", type: "text" },
          messageId: "message-1",
          sessionUpdate: "agent_message_chunk",
        },
      }),
    ).rejects.toThrow("ingress is closed");
    let stopped = false;
    void stop.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    release.resolve();
    await expect(Promise.all([update, stop])).resolves.toEqual([undefined, undefined]);
  });
});
