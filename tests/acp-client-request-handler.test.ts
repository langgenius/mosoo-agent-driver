import { describe, expect, test } from "bun:test";

import {
  DriverPermissionBroker,
  PermissionEventDeliveryError,
} from "../src/core/driver-permission-broker";
import type { DriverPermissionRequest } from "../src/host-ports";
import {
  DriverEventRejectedError,
  type DriverRuntimeEventPort,
} from "../src/core/driver-runtime-io";
import type { DriverEventInput } from "../src/protocol/events";
import { AcpClientRequestHandler } from "../src/runtimes/acp/acp-client-request-handler";
import { AcpAssistantTranscriptState } from "../src/runtimes/acp/acp-assistant-transcript-state";
import { DriverEventPublisher } from "../src/runtimes/driver-event-publisher";
import { beginAcpTranscript } from "./acp-test-helpers";

const BASE_HANDLER_OPTIONS = {
  allowedRoots: [],
  cwd: "/workspace",
  env: {},
  isCancelling: () => false,
  nativeSessionId: () => "native-session-1",
  onUpdateFailure: () => {},
} satisfies Omit<ConstructorParameters<typeof AcpClientRequestHandler>[0], "push" | "turnEvents">;

describe("ACP client request handler", () => {
  test("rejects permission requests outside an active turn", async () => {
    let permissionRequests = 0;
    let pushes = 0;
    const handler = new AcpClientRequestHandler({
      ...BASE_HANDLER_OPTIONS,
      push: async () => {
        pushes += 1;
      },
      turnEvents: new AcpAssistantTranscriptState(),
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
    const turnEvents = beginAcpTranscript();
    let permissionRequests = 0;
    const handler = new AcpClientRequestHandler({
      ...BASE_HANDLER_OPTIONS,
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
      ...BASE_HANDLER_OPTIONS,
      push: async (_context, reason, _events) => {
        pushedReasons.push(reason);
      },
      turnEvents: new AcpAssistantTranscriptState(),
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
      ...BASE_HANDLER_OPTIONS,
      push: async (_context, reason) => {
        pushedReasons.push(reason);
      },
      turnEvents: new AcpAssistantTranscriptState(),
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
      ...BASE_HANDLER_OPTIONS,
      cwd: process.cwd(),
      env: { PATH: "/artifact/bin:/runtime/bin" },
      push: async () => {},
      turnEvents: new AcpAssistantTranscriptState(),
    });
    const context = {} as never;
    await handler.initializePathScope();

    try {
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
    } finally {
      await handler.stopTerminals(context);
    }
  });

  test("serializes official SDK notifications and drains scoped suppression", async () => {
    const gate = Promise.withResolvers<void>();
    const pushedReasons: string[] = [];
    const turnEvents = beginAcpTranscript();
    const handler = new AcpClientRequestHandler({
      ...BASE_HANDLER_OPTIONS,
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

  test("keeps accepting bounded updates while a prior delivery is pending", async () => {
    const firstDelivery = Promise.withResolvers<void>();
    const firstAdmitted = Promise.withResolvers<void>();
    const failures: Error[] = [];
    const pending: Promise<void>[] = [];
    const turnEvents = beginAcpTranscript();
    let pushes = 0;
    const handler = new AcpClientRequestHandler({
      ...BASE_HANDLER_OPTIONS,
      onUpdateFailure: (error) => failures.push(error),
      push: async () => {
        pushes += 1;
        if (pushes === 1) {
          firstAdmitted.resolve();
          await firstDelivery.promise;
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
    const track = (promise: Promise<void>) => {
      pending.push(promise);
      void promise.catch(() => {});
    };

    track(update("first"));
    await firstAdmitted.promise;
    for (let index = 0; index < 1_024; index += 1) {
      track(update(`queued-${index}`));
      await Promise.resolve();
    }
    firstDelivery.resolve();

    const settled = await Promise.allSettled(pending);
    expect(settled.every((result) => result.status === "fulfilled")).toBe(true);
    expect(failures).toEqual([]);
    expect(pushes).toBe(1_025);
  });

  test("admits replay and completed history but rejects genuinely open retained state", async () => {
    const createHandler = () => {
      const failures: Error[] = [];
      const turnEvents = beginAcpTranscript();
      return {
        failures,
        handler: new AcpClientRequestHandler({
          ...BASE_HANDLER_OPTIONS,
          onUpdateFailure: (error) => failures.push(error),
          push: async () => {},
          turnEvents,
        }),
      };
    };

    const repeated = createHandler();
    const repeatedUpdate = {
      sessionId: "native-session-1",
      update: {
        rawOutput: "x".repeat(4 * 1_024),
        sessionUpdate: "tool_call" as const,
        status: "in_progress" as const,
        title: "tool",
        toolCallId: "same-tool",
      },
    };
    for (let index = 0; index < 100; index += 1) {
      await repeated.handler.enqueueUpdate({} as never, repeatedUpdate);
    }
    expect(repeated.failures).toEqual([]);

    const completed = createHandler();
    for (let index = 0; index < 600; index += 1) {
      await completed.handler.enqueueUpdate({} as never, {
        sessionId: "native-session-1",
        update: {
          sessionUpdate: "tool_call",
          status: "completed",
          title: "tool",
          toolCallId: `tool-${index}`,
        },
      });
    }
    expect(completed.failures).toEqual([]);

    const open = createHandler();
    for (let index = 0; index < 509; index += 1) {
      await open.handler.enqueueUpdate({} as never, {
        sessionId: "native-session-1",
        update: {
          sessionUpdate: "tool_call",
          status: "in_progress",
          title: "tool",
          toolCallId: `open-tool-${index}`,
        },
      });
    }
    await expect(
      open.handler.enqueueUpdate({} as never, {
        sessionId: "native-session-1",
        update: {
          sessionUpdate: "tool_call",
          status: "in_progress",
          title: "tool",
          toolCallId: "open-tool-over-limit",
        },
      }),
    ).rejects.toThrow("ACP turn state exceeds 510 retained open items");
    expect(open.failures).toHaveLength(1);

    const byteFlood = createHandler();
    const content = "x".repeat(8 * 1_024);
    for (let index = 0; index < 47; index += 1) {
      await byteFlood.handler.enqueueUpdate({} as never, {
        sessionId: "native-session-1",
        update: {
          content: { text: content, type: "text" },
          messageId: "native-message-1",
          sessionUpdate: "agent_message_chunk",
        },
      });
    }
    await expect(
      byteFlood.handler.enqueueUpdate({} as never, {
        sessionId: "native-session-1",
        update: {
          content: { text: content, type: "text" },
          messageId: "native-message-1",
          sessionUpdate: "agent_message_chunk",
        },
      }),
    ).rejects.toThrow("ACP turn state exceeds 393216 retained UTF-8 bytes");
    expect(byteFlood.failures).toHaveLength(1);
  });

  test("routes permission turn-state overflow through provider fatal cleanup", async () => {
    const failures: Error[] = [];
    const turnEvents = beginAcpTranscript();
    const handler = new AcpClientRequestHandler({
      ...BASE_HANDLER_OPTIONS,
      onUpdateFailure: (error) => failures.push(error),
      push: async () => {},
      turnEvents,
    });

    await expect(
      handler.requestPermission(
        { ports: { permission: { request: async () => "reject_once" } } } as never,
        "r".repeat(400_000),
        {
          options: [{ kind: "allow_once", name: "Allow", optionId: "allow" }],
          sessionId: "native-session-1",
          toolCall: {
            status: "in_progress",
            title: "Run command",
          } as never,
        },
      ),
    ).rejects.toThrow("ACP turn state exceeds 393216 retained UTF-8 bytes");
    expect(failures).toHaveLength(1);
  });

  test("fails every queued update after the first commit failure", async () => {
    const failures: Error[] = [];
    let pushes = 0;
    const turnEvents = beginAcpTranscript();
    const handler = new AcpClientRequestHandler({
      ...BASE_HANDLER_OPTIONS,
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

  test("does not translate a queued update before the prior checkpoint settles", async () => {
    const firstPublishing = Promise.withResolvers<void>();
    const rejectFirst = Promise.withResolvers<void>();
    const attempts: unknown[] = [];
    const turnEvents = beginAcpTranscript();
    const createHandler = (
      push: ConstructorParameters<typeof AcpClientRequestHandler>[0]["push"],
    ) =>
      new AcpClientRequestHandler({
        ...BASE_HANDLER_OPTIONS,
        push,
        turnEvents,
      });
    const handler = createHandler(async (_context, _reason, events) => {
      attempts.push(structuredClone(events));
      firstPublishing.resolve();
      await rejectFirst.promise;
      throw new Error("first update rejected");
    });
    const update = (messageId: string, text: string) => ({
      sessionId: "native-session-1",
      update: {
        content: { text, type: "text" as const },
        messageId,
        sessionUpdate: "agent_message_chunk" as const,
      },
    });
    const first = handler.enqueueUpdate({} as never, update("native-1", "first"));
    const second = handler.enqueueUpdate({} as never, update("native-2", "second"));
    void first.catch(() => {});
    void second.catch(() => {});

    await firstPublishing.promise;
    await Promise.resolve();
    expect(attempts).toHaveLength(1);
    rejectFirst.resolve();
    await expect(first).rejects.toThrow("first update rejected");
    await expect(second).rejects.toThrow("first update rejected");

    const replayed: unknown[] = [];
    await expect(
      createHandler(async (_context, _reason, events) => {
        replayed.push(structuredClone(events));
      }).enqueueUpdate({} as never, update("native-2", "second")),
    ).resolves.toBeUndefined();
    expect((replayed[0] as Array<{ kind: string }>).map((event) => event.kind)).toEqual([
      "message.started",
      "message.delta",
    ]);
  });

  test("rolls back a rejected permission tool before translating a queued update", async () => {
    const permissionPublishing = Promise.withResolvers<void>();
    const rejectPermission = Promise.withResolvers<void>();
    const updateAttempts: unknown[] = [];
    const turnEvents = beginAcpTranscript();
    const handler = new AcpClientRequestHandler({
      ...BASE_HANDLER_OPTIONS,
      push: async (_context, reason, events) => {
        if (reason === "driver.acp.permission.tool") {
          permissionPublishing.resolve();
          await rejectPermission.promise;
          throw new Error("permission tool rejected");
        }

        updateAttempts.push(structuredClone(events));
      },
      turnEvents,
    });
    const context = {
      ports: {
        permission: {
          request: async () => "allow_once" as const,
        },
      },
    } as never;
    const permission = handler.requestPermission(context, 1, {
      options: [{ kind: "allow_once", name: "Allow", optionId: "allow" }],
      sessionId: "native-session-1",
      toolCall: {
        rawInput: "x".repeat(250_000),
        status: "in_progress",
        title: "Run command",
        toolCallId: "tool-1",
      },
    });
    void permission.catch(() => {});

    await permissionPublishing.promise;
    const update = handler.enqueueUpdate(context, {
      sessionId: "native-session-1",
      update: {
        content: { text: "a".repeat(250_000), type: "text" },
        messageId: "native-message-1",
        sessionUpdate: "agent_message_chunk",
      },
    });
    await Promise.resolve();
    expect(updateAttempts).toHaveLength(0);

    rejectPermission.resolve();
    await expect(permission).rejects.toThrow("permission tool rejected");
    await expect(update).resolves.toBeUndefined();
    expect((updateAttempts[0] as Array<{ kind: string }>).map((event) => event.kind)).toEqual([
      "message.started",
      "message.delta",
    ]);
  });

  test("commits a tool update after the publisher resumes a retained suffix", async () => {
    const attempts: DriverEventInput[][] = [];
    let attempt = 0;
    let sequence = 0;
    const turnEvents = beginAcpTranscript();
    const context = {
      logger: { debug: () => {} },
      ports: {
        eventSink: {
          currentRunId: () => "run-1",
          pushEvents: async ({ events }: { events: DriverEventInput[] }) => {
            attempts.push(structuredClone(events));
            attempt += 1;

            if (attempt === 1) {
              return {
                accepted: [
                  { eventId: events[0]!.sourceEventId, seq: ++sequence, type: events[0]!.kind },
                ],
              };
            }

            if (attempt === 2) {
              throw new Error("tool update transport interrupted");
            }

            return {
              accepted: events.map((event) => ({
                eventId: event.sourceEventId,
                seq: ++sequence,
                type: event.kind,
              })),
            };
          },
        },
      },
    } as never;
    const publisher = new DriverEventPublisher("acp-fallback", () => "native-session-1");
    const handler = new AcpClientRequestHandler({
      ...BASE_HANDLER_OPTIONS,
      push: (pushContext, reason, events) => publisher.push(pushContext, reason, events),
      turnEvents,
    });

    await expect(
      handler.enqueueUpdate(context, {
        sessionId: "native-session-1",
        update: {
          kind: "execute",
          sessionUpdate: "tool_call",
          status: "in_progress",
          title: "Run command",
          toolCallId: "tool-1",
        },
      }),
    ).resolves.toBeUndefined();
    const replayedSuffix = attempts[2];
    expect(replayedSuffix?.map((event) => event.kind)).toEqual([
      "item.started",
      "tool.call.updated",
    ]);

    const followupStart = attempts.length;
    await expect(
      handler.enqueueUpdate(context, {
        sessionId: "native-session-1",
        update: {
          rawOutput: "done",
          sessionUpdate: "tool_call_update",
          status: "completed",
          toolCallId: "tool-1",
        },
      }),
    ).resolves.toBeUndefined();
    expect(
      attempts.slice(followupStart).flatMap((batch) => batch.map((event) => event.kind)),
    ).toEqual(["tool.call.updated", "item.completed"]);
  });

  test("rolls back an unchanged tool update after an explicit sink rejection", async () => {
    const attempts: DriverEventInput[][] = [];
    let reject = true;
    let sequence = 0;
    const turnEvents = beginAcpTranscript();
    const context = {
      logger: { debug: () => {} },
      ports: {
        eventSink: {
          currentRunId: () => "run-1",
          pushEvents: async ({ events }: { events: DriverEventInput[] }) => {
            attempts.push(structuredClone(events));
            if (reject) {
              throw new DriverEventRejectedError(
                events[0]!.sourceEventId!,
                new Error("tool update rejected"),
              );
            }

            return {
              accepted: events.map((event) => ({
                eventId: event.sourceEventId,
                seq: ++sequence,
                type: event.kind,
              })),
            };
          },
        },
      },
    } as never;
    const publisher = new DriverEventPublisher("acp-fallback", () => "native-session-1");
    const createHandler = () =>
      new AcpClientRequestHandler({
        ...BASE_HANDLER_OPTIONS,
        push: (pushContext, reason, events) => publisher.push(pushContext, reason, events),
        turnEvents,
      });
    const notification = {
      sessionId: "native-session-1",
      update: {
        kind: "execute" as const,
        sessionUpdate: "tool_call" as const,
        status: "in_progress" as const,
        title: "Run command",
        toolCallId: "tool-1",
      },
    };

    await expect(createHandler().enqueueUpdate(context, notification)).rejects.toThrow(
      "tool update rejected",
    );
    const firstToolEventId = attempts[0]!.at(-1)!.sourceEventId;
    reject = false;
    await expect(createHandler().enqueueUpdate(context, notification)).resolves.toBeUndefined();

    expect(attempts.at(-1)!.map((event) => event.kind)).toEqual([
      "message.started",
      "item.started",
      "tool.call.updated",
    ]);
    expect(attempts.at(-1)!.at(-1)!.sourceEventId).toBe(firstToolEventId);
  });

  test.each(["update drain", "tool event"] as const)(
    "cancels a permission request while waiting on the %s boundary",
    async (boundary) => {
      const blocked = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const turnEvents = beginAcpTranscript();
      let cancelling = false;
      let permissionRequests = 0;
      const blockedReason =
        boundary === "update drain" ? "driver.acp.session.update" : "driver.acp.permission.tool";
      const handler = new AcpClientRequestHandler({
        ...BASE_HANDLER_OPTIONS,
        isCancelling: () => cancelling,
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
    const turnEvents = beginAcpTranscript();
    let permissionRequests = 0;
    const handler = new AcpClientRequestHandler({
      ...BASE_HANDLER_OPTIONS,
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
    const requests: DriverPermissionRequest[] = [];
    const turnEvents = beginAcpTranscript();
    const handler = new AcpClientRequestHandler({
      ...BASE_HANDLER_OPTIONS,
      push: async (_context, _reason, events) => {
        eventKinds.push(...events.map((event) => event.kind));
      },
      turnEvents,
    });
    const context = {
      ports: {
        permission: {
          request: async (request: DriverPermissionRequest) => {
            requests.push(request);
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

    expect(requests.map(({ requestId }) => requestId)).toEqual(["number:1", "string:1", "null"]);
    expect(requests[0]).toEqual({
      rawInput: "",
      requestId: "number:1",
      title: "Run command",
      toolCallId: "tool-0",
      toolKind: null,
    });
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
      const turnEvents = beginAcpTranscript();
      const handler = new AcpClientRequestHandler({
        ...BASE_HANDLER_OPTIONS,
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
    const turnEvents = beginAcpTranscript();
    const handler = new AcpClientRequestHandler({
      ...BASE_HANDLER_OPTIONS,
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
    const turnEvents = beginAcpTranscript();
    let permissionRequests = 0;
    const handler = new AcpClientRequestHandler({
      ...BASE_HANDLER_OPTIONS,
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
    const turnEvents = beginAcpTranscript();
    const handler = new AcpClientRequestHandler({
      ...BASE_HANDLER_OPTIONS,
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

  test("fences a late cancelled permission resolution after run ownership changes", async () => {
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
    const turnEvents = beginAcpTranscript({ runId: activeRunId as never });
    const handler = new AcpClientRequestHandler({
      ...BASE_HANDLER_OPTIONS,
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

    expect(resolvedRunId).toBeNull();
    expect(order).toEqual(["run.cancelled"]);
  });

  test("closes update ingress and drains accepted work before stopping", async () => {
    const blocked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const turnEvents = beginAcpTranscript();
    const handler = new AcpClientRequestHandler({
      ...BASE_HANDLER_OPTIONS,
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
