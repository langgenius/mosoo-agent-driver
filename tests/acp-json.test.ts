import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { setTimeout } from "node:timers/promises";

import { AcpJsonRpcConnection } from "../src/runtimes/acp/acp-json";

interface TestConnection {
  readonly connection: AcpJsonRpcConnection;
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
}

interface TestConnectionOptions {
  readonly onNotification?: (() => Promise<void>) | undefined;
  readonly transportErrors?: string[] | undefined;
}

function createConnection(input?: TestConnectionOptions): TestConnection {
  const stdin = new PassThrough();
  const stdout = new PassThrough();

  return {
    connection: new AcpJsonRpcConnection({
      onInvalidMessage: () => undefined,
      onNotification: input?.onNotification ?? (async () => undefined),
      onRequest: async () => null,
      onTransportError: (error) => {
        input?.transportErrors?.push(error.message);
      },
      stdin,
      stdout,
    }),
    stdin,
    stdout,
  };
}

function closeStreams(input: TestConnection): void {
  input.connection.close("test cleanup");
  input.stdin.destroy();
  input.stdout.destroy();
}

async function readRequestId(stdin: PassThrough): Promise<number> {
  return new Promise((resolve) => {
    stdin.once("data", (chunk: Buffer | string) => {
      const payload: unknown = JSON.parse(chunk.toString());

      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        throw new Error("Expected an ACP JSON-RPC request object.");
      }

      const id = (payload as Record<string, unknown>)["id"];

      if (typeof id !== "number") {
        throw new Error("Expected a numeric ACP JSON-RPC request id.");
      }

      resolve(id);
    });
  });
}

describe("ACP JSON-RPC connection", () => {
  test("closes the connection when the readable stream closes", async () => {
    const transportErrors: string[] = [];
    const rpc = createConnection({ transportErrors });
    const request = rpc.connection.request("ping", {});

    rpc.stdout.end();

    try {
      const outcome = await Promise.race([
        request.then(
          () => ({ status: "resolved" as const }),
          (error: unknown) => ({
            message: error instanceof Error ? error.message : "unknown error",
            status: "rejected" as const,
          }),
        ),
        setTimeout(100).then(() => ({ status: "pending" as const })),
      ]);

      expect(outcome).toMatchObject({
        message: expect.any(String),
        status: "rejected",
      });
      expect(transportErrors).toHaveLength(1);
    } finally {
      closeStreams(rpc);
    }
  });

  test("rejects pending requests when the connection closes", async () => {
    const rpc = createConnection();
    const request = rpc.connection.request("ping", {});

    rpc.connection.close("test cleanup");

    try {
      await expect(request).rejects.toThrow();
    } finally {
      closeStreams(rpc);
    }
  });

  test("drains an earlier session update before resolving its prompt response", async () => {
    let releaseNotification: (() => void) | null = null;
    const notificationGate = new Promise<void>((resolve) => {
      releaseNotification = resolve;
    });
    let notificationHandled = false;
    const rpc = createConnection({
      onNotification: async () => {
        await notificationGate;
        notificationHandled = true;
      },
    });

    try {
      const requestIdPromise = readRequestId(rpc.stdin);
      const request = rpc.connection.request("session/prompt", {});
      const requestId = await requestIdPromise;

      rpc.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: { update: { sessionUpdate: "agent_message_chunk" } },
        })}\n`,
      );
      rpc.stdout.write(`${JSON.stringify({ id: requestId, jsonrpc: "2.0", result: "done" })}\n`);

      const beforeNotification = await Promise.race([
        request.then(
          () => "resolved" as const,
          () => "rejected" as const,
        ),
        setTimeout(20).then(() => "pending" as const),
      ]);

      expect(beforeNotification).toBe("pending");
      expect(notificationHandled).toBe(false);
      releaseNotification?.();
      await expect(request).resolves.toBe("done");
      expect(notificationHandled).toBe(true);
    } finally {
      closeStreams(rpc);
    }
  });

  test("drains queued final frames before EOF closes the transport", async () => {
    let releaseNotification: (() => void) | null = null;
    const notificationGate = new Promise<void>((resolve) => {
      releaseNotification = resolve;
    });
    const rpc = createConnection({
      onNotification: async () => notificationGate,
    });

    try {
      const requestIdPromise = readRequestId(rpc.stdin);
      const request = rpc.connection.request("session/prompt", {});
      const requestId = await requestIdPromise;

      rpc.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: { update: { sessionUpdate: "agent_message_chunk" } },
        })}\n`,
      );
      rpc.stdout.write(`${JSON.stringify({ id: requestId, jsonrpc: "2.0", result: "done" })}\n`);
      rpc.stdout.end();

      releaseNotification?.();
      await expect(request).resolves.toBe("done");
    } finally {
      closeStreams(rpc);
    }
  });

  test("drains queued final frames when process stdin and stdout close together", async () => {
    let releaseNotification: (() => void) | null = null;
    const notificationGate = new Promise<void>((resolve) => {
      releaseNotification = resolve;
    });
    const rpc = createConnection({
      onNotification: async () => notificationGate,
    });

    try {
      const requestIdPromise = readRequestId(rpc.stdin);
      const request = rpc.connection.request("session/prompt", {});
      const requestId = await requestIdPromise;

      rpc.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: { update: { sessionUpdate: "agent_message_chunk" } },
        })}\n`,
      );
      rpc.stdout.write(`${JSON.stringify({ id: requestId, jsonrpc: "2.0", result: "done" })}\n`);
      rpc.stdout.end();
      rpc.stdin.destroy();

      const beforeNotification = await Promise.race([
        request.then(
          () => "resolved" as const,
          () => "rejected" as const,
        ),
        setTimeout(20).then(() => "pending" as const),
      ]);

      expect(beforeNotification).toBe("pending");
      releaseNotification?.();
      await expect(request).resolves.toBe("done");
    } finally {
      closeStreams(rpc);
    }
  });

  test("keeps draining stdout after stdin closes first", async () => {
    let notificationHandled = false;
    const rpc = createConnection({
      onNotification: async () => {
        notificationHandled = true;
      },
    });

    try {
      const requestIdPromise = readRequestId(rpc.stdin);
      const request = rpc.connection.request("session/prompt", {});
      const requestId = await requestIdPromise;
      const stdinClosed = new Promise<void>((resolve) => {
        rpc.stdin.once("close", resolve);
      });

      rpc.stdin.destroy();
      await stdinClosed;
      rpc.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: { update: { sessionUpdate: "agent_message_chunk" } },
        })}\n`,
      );
      rpc.stdout.write(`${JSON.stringify({ id: requestId, jsonrpc: "2.0", result: "done" })}\n`);

      await expect(request).resolves.toBe("done");
      expect(notificationHandled).toBe(true);
    } finally {
      closeStreams(rpc);
    }
  });

  test("rejects new requests after stdin closes", async () => {
    const rpc = createConnection();

    try {
      const stdinClosed = new Promise<void>((resolve) => {
        rpc.stdin.once("close", resolve);
      });

      rpc.stdin.destroy();
      await stdinClosed;

      await expect(rpc.connection.request("ping", {})).rejects.toThrow("ACP stdin closed.");
    } finally {
      closeStreams(rpc);
    }
  });

  test("keeps draining stdout after stdin errors first", async () => {
    const rpc = createConnection();

    try {
      const requestIdPromise = readRequestId(rpc.stdin);
      const request = rpc.connection.request("session/prompt", {});
      const requestId = await requestIdPromise;
      const stdinClosed = new Promise<void>((resolve) => {
        rpc.stdin.once("close", resolve);
      });

      rpc.stdin.destroy(new Error("ACP stdin failed before final stdout frames."));
      await stdinClosed;
      rpc.stdout.write(`${JSON.stringify({ id: requestId, jsonrpc: "2.0", result: "done" })}\n`);

      await expect(request).resolves.toBe("done");
    } finally {
      closeStreams(rpc);
    }
  });

  test("drains queued final frames before a simultaneous stdin error closes transport", async () => {
    let releaseNotification: (() => void) | null = null;
    const notificationGate = new Promise<void>((resolve) => {
      releaseNotification = resolve;
    });
    const rpc = createConnection({
      onNotification: async () => notificationGate,
    });

    try {
      const requestIdPromise = readRequestId(rpc.stdin);
      const request = rpc.connection.request("session/prompt", {});
      const requestId = await requestIdPromise;

      rpc.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: { update: { sessionUpdate: "agent_message_chunk" } },
        })}\n`,
      );
      rpc.stdout.write(`${JSON.stringify({ id: requestId, jsonrpc: "2.0", result: "done" })}\n`);
      rpc.stdout.end();
      rpc.stdin.destroy(new Error("ACP stdin failed during process exit."));

      const beforeNotification = await Promise.race([
        request.then(
          () => "resolved" as const,
          () => "rejected" as const,
        ),
        setTimeout(20).then(() => "pending" as const),
      ]);

      expect(beforeNotification).toBe("pending");
      releaseNotification?.();
      await expect(request).resolves.toBe("done");
    } finally {
      closeStreams(rpc);
    }
  });

  test("drains queued final frames before a simultaneous stdout error closes transport", async () => {
    let releaseNotification: (() => void) | null = null;
    const notificationGate = new Promise<void>((resolve) => {
      releaseNotification = resolve;
    });
    const rpc = createConnection({
      onNotification: async () => notificationGate,
    });

    try {
      const requestIdPromise = readRequestId(rpc.stdin);
      const request = rpc.connection.request("session/prompt", {});
      const requestId = await requestIdPromise;

      rpc.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: { update: { sessionUpdate: "agent_message_chunk" } },
        })}\n`,
      );
      rpc.stdout.write(`${JSON.stringify({ id: requestId, jsonrpc: "2.0", result: "done" })}\n`);
      rpc.stdout.destroy(new Error("ACP stdout failed during process exit."));
      rpc.stdin.destroy();

      const beforeNotification = await Promise.race([
        request.then(
          () => "resolved" as const,
          () => "rejected" as const,
        ),
        setTimeout(20).then(() => "pending" as const),
      ]);

      expect(beforeNotification).toBe("pending");
      releaseNotification?.();
      await expect(request).resolves.toBe("done");
    } finally {
      closeStreams(rpc);
    }
  });
});
