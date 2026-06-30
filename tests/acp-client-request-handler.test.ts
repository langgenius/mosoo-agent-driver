import { describe, expect, test } from "bun:test";

import { AcpClientRequestHandler } from "../src/runtimes/acp/acp-client-request-handler";
import { AcpTurnEventState } from "../src/runtimes/acp/acp-event-translator";

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
});
