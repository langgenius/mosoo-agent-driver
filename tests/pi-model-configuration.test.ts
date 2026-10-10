import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { isJsonObject } from "../src/protocol/json";
import { readPiModelConfiguration } from "../src/runtimes/pi/pi-configuration";
import { PI_MODEL_CONFIGURATION_SOURCE } from "../src/runtimes/pi/pi-model-configuration";
import { PiRpcClient } from "../src/runtimes/pi/pi-rpc-client";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).toReversed()) await dispose();
});

async function inspectModel(vendor: string, id: string, modelProtocol: string, resumed = false) {
  const home = await mkdtemp(join(tmpdir(), "mosoo-pi-model-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const agentDir = join(home, "pi");
  await mkdir(agentDir);
  const baseUrl = "http://127.0.0.1:1/model-proxy";
  const variables = {
    MOSOO_PI_CONFIG_CONTENT: JSON.stringify({ baseUrl, modelProtocol }),
    MOSOO_PI_PROXY_GRANT: "test-grant",
  };
  const configuration = readPiModelConfiguration({
    provider: vendor,
    model: `${vendor}/${id}`,
    providerOptions: {},
    environment: { variables },
  });
  const { api, provider } = configuration;
  const extension = join(agentDir, "mosoo-model.mjs");
  await writeFile(
    extension,
    `${PI_MODEL_CONFIGURATION_SOURCE}\nexport default function (pi) { configurePiModel(pi, ${JSON.stringify(configuration)}); }`,
  );
  await writeFile(join(agentDir, "models.json"), "{}");
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
        ...variables,
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
    api,
  };
}

test.each([
  ["deepseek", "deepseek-v4-pro", "openai-chat-completions"],
  ["openai", "gpt-5.4", "openai-responses"],
  ["anthropic", "claude-sonnet-5", "anthropic-messages"],
  ["gemini", "gemini-3.5-flash", "google-gemini"],
  ["gemini", "gemini-3.5-flash", "openai-chat-completions"],
  ["kimi", "kimi-k2.7-code", "openai-chat-completions"],
  ["zhipu", "glm-4.7", "openai-chat-completions"],
  ["minimax", "MiniMax-M3", "anthropic-messages"],
])(
  "preserves native %s/%s metadata when configuring %s through a proxy",
  async (vendor, id, modelProtocol) => {
    const { model, builtin, baseUrl, api } = await inspectModel(vendor, id, modelProtocol);
    expect(builtin).toBeDefined();
    expect(model).toMatchObject(JSON.parse(JSON.stringify({ ...builtin, api, baseUrl })));
  },
  20_000,
);

test("cold restoration selects the enriched native model before accepting input", async () => {
  const { model, builtin, baseUrl, levels } = await inspectModel(
    "deepseek",
    "deepseek-v4-pro",
    "openai-chat-completions",
    true,
  );
  expect(model).toMatchObject(JSON.parse(JSON.stringify({ ...builtin, baseUrl })));
  expect(levels).toEqual(["off", "high", "max"]);
}, 20_000);

test("unknown custom models retain explicit text-only defaults and only support thinking off", async () => {
  const { model, builtin, levels } = await inspectModel(
    "openai-compatible",
    "custom-model",
    "openai-chat-completions",
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
