import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AcpProcess, waitFor } from "./fixtures/pi-acp/contract";

// Exercise the installed adapter over ACP, with an isolated native Pi RPC child.
// This fixture never contacts a model provider or uses credentials.
const nativeRpc = String.raw`#!/usr/bin/env node
if (process.argv.includes("--version")) process.exit(0);
let buffer = "";
let waiting = false;
let delayedStats = false;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const reply = (command, data = {}) => send({ type: "response", id: command.id,
  command: command.type, success: true, data });
const assistant = (stopReason, errorMessage) => ({ role: "assistant", stopReason,
  errorMessage, content: [] });
const complete = (stopReason = "stop", errorMessage, duplicate = false) => {
  const message = assistant(stopReason, errorMessage);
  send({ type: "message_end", message });
  send({ type: "agent_end", messages: [message], willRetry: false });
  send({ type: "agent_settled" });
  if (duplicate) send({ type: "agent_settled" });
};
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\n")) {
    const index = buffer.indexOf("\n");
    const command = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    if (command.type === "get_state") {
      reply(command, { model: { provider: "fixture", id: "model" }, thinkingLevel: "off" });
    } else if (command.type === "get_available_models") {
      reply(command, { models: [{ provider: "fixture", id: "model", name: "Fixture" }] });
    } else if (command.type === "get_available_thinking_levels") {
      reply(command, { levels: ["off"] });
    } else if (command.type === "get_session_stats") {
      if (delayedStats) {
        delayedStats = false;
        setTimeout(() => reply(command), 60);
      } else reply(command);
    } else if (command.type === "prompt") {
      const scenario = command.message;
      if (scenario === "rpc-error") {
        send({ type: "response", id: command.id, command: "prompt", success: false,
          error: "Provider HTTP 500 during preflight" });
        continue;
      }
      reply(command);
      send({ type: "agent_start" });
      send({ type: "message_update", assistantMessageEvent: {
        type: "text_delta", delta: "PARTIAL:" + scenario } });
      if (scenario === "error") complete("error", "Provider HTTP 500 after tool");
      else if (scenario === "empty-error") complete("error");
      else if (scenario === "length") complete("length");
      else if (scenario === "aborted") complete("aborted");
      else if (scenario === "retry-success") {
        const failed = assistant("error", "Temporary provider error");
        send({ type: "message_end", message: failed });
        send({ type: "agent_end", messages: [failed], willRetry: true });
        send({ type: "auto_retry_start", attempt: 1, maxAttempts: 1, delayMs: 0 });
        send({ type: "agent_start" });
        send({ type: "auto_retry_end", success: true, attempt: 1 });
        const succeeded = assistant("stop");
        send({ type: "message_end", message: succeeded });
        send({ type: "agent_end", messages: [failed, succeeded], willRetry: false });
        send({ type: "agent_settled" });
      } else if (scenario === "retry-error") {
        send({ type: "message_end", message: assistant("error", "Provider HTTP 500 exhausted") });
        send({ type: "auto_retry_end", success: false, attempt: 2,
          finalError: "Provider HTTP 500 exhausted" });
        send({ type: "agent_settled" });
      } else if (scenario === "wait-cancel") waiting = true;
      else if (scenario === "duplicate") {
        delayedStats = true;
        complete("stop", undefined, true);
      } else if (scenario === "slow-next") setTimeout(() => complete("length"), 120);
      else if (scenario === "spoof") {
        send({ type: "message_end", message: { role: "toolResult", stopReason: "error",
          errorMessage: "Untrusted tool output" } });
        complete();
      } else complete();
    } else if (command.type === "abort") {
      reply(command);
      if (waiting) {
        waiting = false;
        complete("error", "Provider error concurrent with cancellation");
      }
    } else reply(command);
  }
});
process.stdin.on("end", () => process.exit(0));
`;

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "pi-acp-adapter-outcomes-"));
  const bin = join(directory, "bin");
  await mkdir(bin);
  const executable = join(bin, "pi");
  await writeFile(executable, nativeRpc);
  await chmod(executable, 0o755);
  const client = new AcpProcess(directory, {
    ...process.env,
    HOME: directory,
    PI_CODING_AGENT_DIR: join(directory, "agent"),
    PI_ACP_PI_COMMAND: executable,
    PATH: `${bin}:${process.env["PATH"] ?? ""}`,
  });
  try {
    await client.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const session = await client.request("session/new", { cwd: directory, mcpServers: [] });
    return {
      client,
      sessionId: session.sessionId,
      cleanup: async () => {
        try {
          await client.stop();
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await client.stop();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

test("Given native terminal outcomes, When the adapter settles, Then ACP preserves errors, token limits, and aborts", async () => {
  const { client, sessionId, cleanup } = await fixture();
  try {
    expect((await client.prompt(sessionId, "success")).stopReason).toBe("end_turn");
    await expect(client.prompt(sessionId, "error")).rejects.toThrow("Provider HTTP 500 after tool");
    expect(
      client.updates.some(
        (update) =>
          update.content &&
          !Array.isArray(update.content) &&
          update.content.text === "PARTIAL:error",
      ),
    ).toBe(true);
    expect((await client.prompt(sessionId, "success")).stopReason).toBe("end_turn");
    await expect(client.prompt(sessionId, "empty-error")).rejects.toThrow(
      "Pi provider request failed",
    );
    expect((await client.prompt(sessionId, "length")).stopReason).toBe("max_tokens");
    expect((await client.prompt(sessionId, "aborted")).stopReason).toBe("cancelled");
    expect((await client.prompt(sessionId, "spoof")).stopReason).toBe("end_turn");
    await expect(client.prompt(sessionId, "rpc-error")).rejects.toThrow(
      "Provider HTTP 500 during preflight",
    );
    expect((await client.prompt(sessionId, "success")).stopReason).toBe("end_turn");
  } finally {
    await cleanup();
  }
}, 20_000);

test("Given retry errors, When a later assistant succeeds or retries exhaust, Then only the final outcome settles", async () => {
  const { client, sessionId, cleanup } = await fixture();
  try {
    expect((await client.prompt(sessionId, "retry-success")).stopReason).toBe("end_turn");
    const start = client.updates.length;
    await expect(client.prompt(sessionId, "retry-error")).rejects.toThrow(
      "Provider HTTP 500 exhausted",
    );
    expect(JSON.stringify(client.updates.slice(start))).not.toContain("Retry finished, resuming.");
  } finally {
    await cleanup();
  }
}, 20_000);

test("Given cancellation racing a native provider error, When Pi settles, Then explicit cancellation wins", async () => {
  const { client, sessionId, cleanup } = await fixture();
  try {
    const result = client.prompt(sessionId, "wait-cancel");
    await waitFor(
      () => JSON.stringify(client.updates).includes("PARTIAL:wait-cancel"),
      "pending prompt",
    );
    client.cancel(sessionId);
    expect((await result).stopReason).toBe("cancelled");
    expect((await client.prompt(sessionId, "success")).stopReason).toBe("end_turn");
  } finally {
    await cleanup();
  }
}, 20_000);

test("Given duplicate settlement while stats are pending, When a queued prompt starts, Then stale settlement cannot complete it", async () => {
  const { client, sessionId, cleanup } = await fixture();
  try {
    const first = client.prompt(sessionId, "duplicate");
    const next = client.prompt(sessionId, "slow-next");
    expect((await first).stopReason).toBe("end_turn");
    expect((await next).stopReason).toBe("max_tokens");
  } finally {
    await cleanup();
  }
}, 20_000);
