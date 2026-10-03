import { join } from "node:path";

import { z } from "zod";

import type { AgentDriverMaterializedSkill } from "../../host-ports";
import type { DriverStartInput } from "../../protocol/start";
import { ensureAbsoluteRealDirectory, writeFileAtomically } from "../atomic-file";
import { buildNativeRuntimeSystemPrompt } from "../skill-bootstrap";

const thinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high"]);
const optionsSchema = z
  .object({
    pi: z.object({ thinkingLevel: thinkingLevelSchema.optional() }).strict().optional(),
  })
  .strict();
const grantClaimsSchema = z
  .object({
    action: z.literal("llm_proxy"),
    projectId: z.string().min(1).optional(),
    appId: z.string().min(1).optional(),
    driverInstanceId: z.string().min(1),
    driverGeneration: z.number().int().nonnegative(),
    resourceId: z.string().min(1),
    expiresAt: z.number().finite(),
    modelId: z.string().min(1),
    modelProtocol: z.literal("openai-chat-completions"),
  })
  .refine((claims) => claims.appId !== undefined || claims.projectId !== undefined);

export function assertPiPromptText(text: string): void {
  // pi-acp expands its own project templates and implements model/session
  // commands independently of Pi's resource flags. First-PR input is text only.
  if (text.trimStart().startsWith("/")) {
    throw new Error("Pi adapter slash commands are unsupported for frozen executions.");
  }
}

export function readPiModelId(payload: DriverStartInput): string {
  const { provider, model } = payload.execution;
  return model.startsWith(`${provider}/`) ? model.slice(provider.length + 1) : model;
}

export function readPiThinkingLevel(
  payload: DriverStartInput,
): z.infer<typeof thinkingLevelSchema> {
  const options = optionsSchema.safeParse(payload.execution.providerOptions);
  if (!options.success)
    throw new Error("Pi requires supported, frozen providerOptions.pi settings.");
  return options.data.pi?.thinkingLevel ?? "off";
}

/** Structural admission only: the Mosoo proxy, never the sandbox, verifies the
 * signature and active generation. No signing key or provider secret enters Pi. */
export function assertPiConfiguration(payload: DriverStartInput): void {
  const execution = payload.execution;
  if (execution.provider !== "openai-compatible") {
    throw new Error("Pi requires the openai-compatible Mosoo Chat Completions proxy.");
  }
  if (execution.permissionPolicy !== "full_access") {
    throw new Error(
      "Pi requires full_access: pinned pi-acp cannot enforce ordinary tool approvals.",
    );
  }
  if (execution.builtInTools.some((tool) => !tool.enabled)) {
    throw new Error("Pi requires unrestricted built-in tools.");
  }
  if (execution.session.mcpServers.length > 0) {
    throw new Error("Pi requires no MCP servers: pinned pi-acp stores but does not execute them.");
  }
  if (execution.session.additionalDirectories.length > 0) {
    throw new Error("Pi requires no additionalDirectories: pinned pi-acp does not support them.");
  }
  readPiThinkingLevel(payload);
  const variables = execution.environment.variables;
  const token = variables["OPENAI_COMPATIBLE_API_KEY"] ?? "";
  const base = variables["OPENAI_COMPATIBLE_BASE_URL"] ?? "";
  try {
    const parts = token.split(".");
    if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part)))
      throw new Error();
    if (Buffer.from(parts[1]!, "base64url").length !== 32) throw new Error();
    const claims = grantClaimsSchema.parse(
      JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")),
    );
    const url = new URL(base);
    // Mosoo local Cloudflare provisioning rewrites loopback to this fixed Docker alias.
    const localOrigin = ["127.0.0.1", "[::1]", "localhost", "host.docker.internal"].includes(
      url.hostname,
    );
    if (url.protocol !== "https:" && !(url.protocol === "http:" && localOrigin)) throw new Error();
    if (url.username || url.password || url.search || url.hash) throw new Error();
    if (url.pathname !== `/api/driver/llm/proxy/${encodeURIComponent(claims.resourceId)}`)
      throw new Error();
    if (
      claims.driverInstanceId !== payload.driverInstanceId ||
      claims.driverGeneration !== payload.driverGeneration ||
      claims.expiresAt <= Date.now() ||
      claims.modelId !== readPiModelId(payload)
    )
      throw new Error();
  } catch {
    // Do not include token, claims or URL in diagnostics.
    throw new Error(
      "Pi requires an unexpired model-bound Mosoo LLM proxy grant and matching proxy URL.",
    );
  }
}

export function buildPiChildEnv(payload: DriverStartInput): Record<string, string> {
  assertPiConfiguration(payload);
  const home = join(payload.execution.session.homePath, "pi-acp");
  // Platform-owned allowlist: Agent variables, runtime injection hooks, proxy
  // settings, artifact PATH/NODE_PATH and ambient credentials cannot alter launch.
  return {
    HOME: home,
    PATH: "/usr/local/bin:/usr/bin:/bin",
    PWD: payload.execution.session.cwd,
    MOSOO_ACP_HOME: home,
    PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
    PI_ACP_PI_COMMAND: "/usr/local/bin/mosoo-pi",
    MOSOO_PI_PROXY_GRANT: payload.execution.environment.variables["OPENAI_COMPATIBLE_API_KEY"]!,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    npm_config_offline: "true",
    IS_SANDBOX: "1",
  };
}

export function buildPiBootstrapFiles(
  payload: DriverStartInput,
  skills: readonly AgentDriverMaterializedSkill[],
): Readonly<Record<string, string>> {
  assertPiConfiguration(payload);
  const model = readPiModelId(payload);
  const thinkingLevel = readPiThinkingLevel(payload);
  const skillArgs = skills
    .map((skill) => `--skill '${skill.skillMarkdownPath.replaceAll("'", "'\\''")}'`)
    .join(" ");
  return {
    "models.json": JSON.stringify({
      providers: {
        mosoo: {
          api: "openai-completions",
          baseUrl: payload.execution.environment.variables["OPENAI_COMPATIBLE_BASE_URL"],
          apiKey: "$MOSOO_PI_PROXY_GRANT",
          authHeader: true,
          models: [
            {
              id: model,
              name: model,
              reasoning: thinkingLevel !== "off",
              input: ["text"],
              contextWindow: 128_000,
              maxTokens: 16_384,
            },
          ],
        },
      },
    }),
    "settings.json": JSON.stringify({
      defaultProvider: "mosoo",
      defaultModel: model,
      defaultThinkingLevel: thinkingLevel,
      defaultProjectTrust: "never",
      cacheWarming: "off",
      enableInstallTelemetry: false,
      enableAnalytics: false,
      packages: [],
      extensions: [],
      prompts: [],
      skills: skills.map((skill) => skill.skillMarkdownPath),
    }),
    // --no-skills disables both discovery and settings.skills in pinned Pi.
    // Admit Host Skills through explicit CLI paths instead; quote literal paths
    // so whitespace, newlines and shell syntax cannot become launch arguments.
    "mosoo-skills.sh": skillArgs ? `set -- ${skillArgs} "$@"\n` : "",
    // Fresh credentials and trust are execution-scoped, not restore state.
    "auth.json": "{}",
    "trust.json": "{}",
    "SYSTEM.md": "",
    "APPEND_SYSTEM.md": buildNativeRuntimeSystemPrompt(payload.execution) ?? "",
  };
}

export async function preparePiBootstrap(
  payload: DriverStartInput,
  skills: readonly AgentDriverMaterializedSkill[],
  signal: AbortSignal,
): Promise<void> {
  const files = buildPiBootstrapFiles(payload, skills);
  const path = join(payload.execution.session.homePath, "pi-acp", ".pi", "agent");
  // Use Linux descriptor-relative, no-symlink atomic writes.
  // Sessions and the sibling .pi/pi-acp/session-map.json are deliberately untouched.
  await using directory = await ensureAbsoluteRealDirectory(
    path,
    "Pi runtime configuration",
    signal,
  );
  for (const [name, contents] of Object.entries(files)) {
    await writeFileAtomically(directory, name, contents, 0o600, signal);
  }
}
