import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createAgentDriverContext } from "../src/core/agent-driver-backend";
import { createBufferedSinkLogger } from "../src/observability";
import type { JsonObject } from "../src/protocol/json";
import type { DriverStartInput } from "../src/protocol/start";
import { createNativeCheckpoint, pinNativeCheckpointRoot } from "../src/runtimes/native-checkpoint";
import { preparePiLaunch } from "../src/runtimes/pi/pi-configuration";
import { PiDriverBackend } from "../src/runtimes/pi/pi-driver-backend";
import { PiRpcClient } from "../src/runtimes/pi/pi-rpc-client";
import { driverStartInput, DRIVER_TEST_IDS } from "./driver-boot-payload-fixture";

const cli =
  process.env["MOSOO_PI_TEST_CLI"] ??
  join(
    dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
    "bundle",
    "cli.js",
  );
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).toReversed()) await dispose();
});

async function harness(
  providerOptions: JsonObject,
  restored = false,
  selection = { provider: "deepseek", model: "deepseek-v4-pro" },
) {
  const root = await mkdtemp(join(tmpdir(), "mosoo-pi-thinking-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const nativeRef = {
    runtimeId: "pi",
    kind: "pi_session_path",
    value: "sessions/restored-thinking.jsonl",
  } as const;
  const checkpoint = restored
    ? await createNativeCheckpoint({
        root: await pinNativeCheckpointRoot(root),
        runId: DRIVER_TEST_IDS.runId,
        nativeRef,
        signal: AbortSignal.timeout(5_000),
        write: async (directory) => {
          const timestamp = new Date().toISOString();
          await writeFile(
            join(directory, "session.jsonl"),
            [
              { type: "session", version: 3, id: "restored-thinking", timestamp, cwd: root },
              {
                type: "model_change",
                id: "model",
                parentId: null,
                timestamp,
                provider: selection.provider,
                modelId: selection.model,
              },
              {
                type: "thinking_level_change",
                id: "thinking",
                parentId: "model",
                timestamp,
                thinkingLevel: "off",
              },
              {
                type: "message",
                id: "message",
                parentId: "thinking",
                timestamp,
                message: { role: "user", content: "Remember this.", timestamp: Date.now() },
              },
            ]
              .map((entry) => JSON.stringify(entry))
              .join("\n") + "\n",
          );
        },
      })
    : null;
  const payload: DriverStartInput = {
    ...driverStartInput,
    runtime: "pi",
    runtimeTransport: "pi-rpc",
    execution: {
      ...driverStartInput.execution,
      ...selection,
      providerOptions,
      environment: {
        variables: {
          MOSOO_PI_PROXY_GRANT: "test-grant",
          MOSOO_PI_CONFIG_CONTENT: JSON.stringify({
            baseUrl: "http://127.0.0.1:1",
            modelProtocol: "openai-chat-completions",
          }),
        },
      },
      session: {
        ...driverStartInput.execution.session,
        homePath: root,
        cwd: root,
        sharedRootPath: root,
        nativeResumeRef: checkpoint === null ? null : nativeRef,
        nativeCheckpoint: checkpoint,
      },
    },
  };
  let seq = 0;
  const context = createAgentDriverContext({
    payload,
    logger: createBufferedSinkLogger({ level: "error", service: "pi-test", sink: async () => {} }),
    eventSink: {
      currentRunId: () => null,
      pushEvents: async ({ events }) => ({
        accepted: events.map((event) => ({
          eventId: event.sourceEventId!,
          seq: ++seq,
          type: event.kind,
        })),
      }),
    },
    permission: { request: async () => "allow_once" },
    ports: { skill: { materialize: async () => [] } },
  });
  const commands: { type: string; fields: JsonObject | undefined }[] = [];
  const initialStates: JsonObject[] = [];
  let client: PiRpcClient | null = null;
  const backend = new PiDriverBackend(payload, {
    prepare: async (input, skills, signal) => {
      const config = await preparePiLaunch(input, skills, signal);
      return { ...config, command: "node", args: [cli, ...config.args] };
    },
    createClient: (config, onRecord, onFailure) => {
      const rpc = new PiRpcClient(config, onRecord, onFailure);
      client = rpc;
      return {
        request: async (type, fields, signal) => {
          commands.push({ type, fields });
          const result = await rpc.request(type, fields, signal);
          if (type === "get_state") initialStates.push(result);
          return result;
        },
        send: (record) => rpc.send(record),
        stop: () => rpc.stop(),
      };
    },
  });
  cleanup.push(() => backend.stop(context, "test.cleanup", AbortSignal.timeout(10_000)));
  return {
    backend,
    context,
    commands,
    initialStates,
    state: async () => {
      if (client === null) throw new Error("Pi did not start.");
      return client.request("get_state", {}, AbortSignal.timeout(5_000));
    },
  };
}

test("omitted thinking level preserves Pi's native default", async () => {
  const run = await harness({});
  await run.backend.start(run.context, AbortSignal.timeout(20_000));
  expect(run.commands.map(({ type }) => type)).toEqual(["get_state"]);
  expect((await run.state())["thinkingLevel"]).toBe(run.initialStates[0]!["thinkingLevel"]);
}, 30_000);

test("applies a thinking level supported by the selected native model", async () => {
  const run = await harness({ thinkingLevel: "high" });
  await run.backend.start(run.context, AbortSignal.timeout(20_000));
  expect(run.commands).toContainEqual({ type: "set_thinking_level", fields: { level: "high" } });
  expect((await run.state())["thinkingLevel"]).toBe("high");
}, 30_000);

test.each([
  { thinkingLevel: "medium", error: "not supported by the selected model" },
  { thinkingLevel: 42, error: "must be a string" },
])(
  "rejects invalid thinking level $thinkingLevel before prompting",
  async ({ thinkingLevel, error }) => {
    const run = await harness({ thinkingLevel });
    await expect(run.backend.start(run.context, AbortSignal.timeout(20_000))).rejects.toThrow(
      error,
    );
    await expect(
      run.backend.handleInput(run.context, { text: "Must not run." }, DRIVER_TEST_IDS.runId),
    ).rejects.toThrow("unavailable");
    expect(
      run.commands.some(({ type }) => type === "prompt" || type === "set_thinking_level"),
    ).toBe(false);
  },
  30_000,
);

test("reapplies the configured thinking level after restoring a native checkpoint", async () => {
  const run = await harness({ thinkingLevel: "high" }, true);
  await run.backend.start(run.context, AbortSignal.timeout(20_000));
  expect(run.initialStates[0]!["thinkingLevel"]).toBe("off");
  expect((await run.state())["thinkingLevel"]).toBe("high");
}, 30_000);

test("rejects thinking for an unknown custom model before prompting", async () => {
  const run = await harness({ thinkingLevel: "high" }, false, {
    provider: "openai-compatible",
    model: "custom-model",
  });
  await expect(run.backend.start(run.context, AbortSignal.timeout(20_000))).rejects.toThrow(
    "not supported by the selected model",
  );
  expect(run.commands.some(({ type }) => type === "prompt" || type === "set_thinking_level")).toBe(
    false,
  );
}, 30_000);
