import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { isJsonObject } from "../src/protocol/json";
import { PI_MODEL_CONFIGURATION_SOURCE } from "../src/runtimes/pi/pi-model-configuration";
import { PiRpcClient } from "../src/runtimes/pi/pi-rpc-client";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).toReversed()) await dispose();
});

async function inspectModel(provider: string, id: string, api: string, resumed = false) {
  const home = await mkdtemp(join(tmpdir(), "mosoo-pi-model-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const agentDir = join(home, "pi");
  await mkdir(agentDir);
  const baseUrl = "http://127.0.0.1:1/model-proxy";
  const config = {
    providers: {
      [provider]: { api, apiKey: "${MOSOO_PI_PROXY_GRANT}", baseUrl, models: [{ id }] },
    },
  };
  const extension = join(agentDir, "mosoo-model.mjs");
  await writeFile(extension, `${PI_MODEL_CONFIGURATION_SOURCE}\nexport default configurePiModel;`);
  await writeFile(join(agentDir, "models.json"), JSON.stringify(config));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
  const session = join(home, "session.jsonl");
  if (resumed) {
    await writeFile(
      session,
      [
        {
          type: "session",
          version: 3,
          id: "restored-model",
          timestamp: new Date().toISOString(),
          cwd: home,
        },
        {
          type: "model_change",
          id: "model",
          parentId: null,
          timestamp: new Date().toISOString(),
          provider,
          modelId: id,
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
  }
  const client = new PiRpcClient(
    {
      command: "node",
      args: [
        fileURLToPath(
          new URL(
            "../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
            import.meta.url,
          ),
        ),
        "--mode",
        "rpc",
        "--provider",
        provider,
        "--model",
        id,
        "--offline",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--extension",
        extension,
        ...(resumed ? ["--session", session] : []),
      ],
      home,
      cwd: home,
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: home,
        PI_CODING_AGENT_DIR: agentDir,
        PI_OFFLINE: "1",
        MOSOO_PI_CONFIG_CONTENT: JSON.stringify(config),
        MOSOO_PI_PROXY_GRANT: "test-grant",
      },
    },
    async () => {},
    () => {},
  );
  cleanup.push(() => client.stop());
  const state = await client.request("get_state", {}, AbortSignal.timeout(15_000));
  if (!isJsonObject(state["model"])) throw new Error("Pi omitted its selected model.");
  const levels = await client.request(
    "get_available_thinking_levels",
    {},
    AbortSignal.timeout(5_000),
  );
  const catalog = await ModelRuntime.create({
    authPath: join(home, "unused-auth.json"),
    modelsPath: join(home, "unused-models.json"),
    allowModelNetwork: false,
  });
  return {
    model: state["model"],
    levels: levels["levels"],
    builtin: catalog.getModel(provider, id),
    baseUrl,
  };
}

test.each([
  ["deepseek", "deepseek-v4-pro", "openai-completions"],
  ["openai", "gpt-5.4", "openai-responses"],
  ["anthropic", "claude-sonnet-5", "anthropic-messages"],
  ["google", "gemini-3.5-flash", "google-generative-ai"],
  ["google", "gemini-3.5-flash", "openai-completions"],
  ["moonshotai", "kimi-k2.7-code", "openai-completions"],
  ["zai", "glm-4.7", "openai-completions"],
  ["minimax", "MiniMax-M3", "anthropic-messages"],
])(
  "preserves native %s/%s metadata when configuring %s through a proxy",
  async (provider, id, api) => {
    const { model, builtin, baseUrl } = await inspectModel(provider, id, api);
    expect(builtin).toBeDefined();
    expect(model).toMatchObject(JSON.parse(JSON.stringify({ ...builtin, api, baseUrl })));
  },
  20_000,
);

test("cold restoration selects the enriched native model before accepting input", async () => {
  const { model, builtin, baseUrl, levels } = await inspectModel(
    "deepseek",
    "deepseek-v4-pro",
    "openai-completions",
    true,
  );
  expect(model).toMatchObject(JSON.parse(JSON.stringify({ ...builtin, baseUrl })));
  expect(levels).toEqual(["off", "high", "max"]);
}, 20_000);

test("unknown custom models retain explicit text-only defaults and only support thinking off", async () => {
  const { model, builtin, levels } = await inspectModel(
    "openai-compatible",
    "custom-model",
    "openai-completions",
  );
  expect(builtin).toBeUndefined();
  expect(model).toMatchObject({
    id: "custom-model",
    provider: "openai-compatible",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  });
  expect(levels).toEqual(["off"]);
}, 20_000);
