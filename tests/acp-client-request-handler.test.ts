import { describe, expect, test } from "bun:test";

import { AcpClientRequestHandler } from "../src/runtimes/acp/acp-client-request-handler";
import { AcpTurnEventState } from "../src/runtimes/acp/acp-event-translator";
import { AcpTerminalManager } from "../src/runtimes/acp/acp-terminal-manager";

describe("ACP client request handler", () => {
  test("suppresses turn-scoped session updates before a turn is active", async () => {
    const pushedReasons: string[] = [];
    const handler = new AcpClientRequestHandler({
      allowedRoots: [],
      cwd: "/workspace",
      isTurnCancelRequested: () => false,
      nativeSessionId: () => "native-session-1",
      push: async (_context, reason, _events) => {
        pushedReasons.push(reason);
      },
      turnEvents: new AcpTurnEventState(),
    });

    for (const replaying of [false, true]) {
      const sendUpdate = async () => {
        await handler.handleNotification({} as never, {
          method: "session/update",
          params: {
            sessionId: "native-session-1",
            update: {
              content: {
                text: "replayed assistant text",
                type: "text",
              },
              sessionUpdate: "agent_message_chunk",
            },
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

  test("prepends artifact paths to terminal child processes", async () => {
    const manager = new AcpTerminalManager({
      allowedRoots: [],
      cwd: process.cwd(),
      paths: { executable: ["/artifact/bin"], node: [], python: [] },
      push: async () => {},
    });
    const { terminalId } = await manager.create({} as never, {
      args: ["-e", "process.stdout.write(process.env.PATH ?? '')"],
      command: process.execPath,
      env: [],
    });

    await manager.waitForExit({ terminalId });

    expect(manager.output({ terminalId }).output).toStartWith("/artifact/bin:");
  });
});
