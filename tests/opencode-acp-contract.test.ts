import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readNativeCheckpoint } from "../src/runtimes/native-checkpoint";

import {
  client as createAcpClient,
  methods as acpMethods,
  ndJsonStream,
} from "@agentclientprotocol/sdk";
import type { ClientConnection } from "@agentclientprotocol/sdk";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";

import {
  ACP_PROTOCOL_VERSION,
  assertProtocolVersion,
  buildClientCapabilities,
} from "../src/runtimes/acp/acp-configuration";
import { limitAcpInput } from "../src/runtimes/acp/acp-input-limit";
import { setupAcpSession } from "../src/runtimes/acp/acp-session-setup";
import { createDisabledLogger } from "../src/observability";
import { exposeNativeSkillAliases } from "../src/runtimes/skill-bootstrap";
import { createAgentDriverContext } from "../src/core/agent-driver-backend";
import type { DriverEventInput } from "../src/protocol/events";
import type { RunId } from "../src/protocol/id";
import { parseNativeCheckpoint, type NativeCheckpoint } from "../src/protocol/native-checkpoint";
import type { DriverStartInput } from "../src/protocol/start";
import { AcpDriverBackend } from "../src/runtimes/acp/acp-driver-backend";
import { settlePromiseWithTimeout } from "../src/utils/async";
import { openCodeDataPath } from "../src/runtimes/acp/opencode-checkpoint";
import {
  DRIVER_TEST_IDS,
  driverBootPayload,
  driverStartInput,
} from "./driver-boot-payload-fixture";

const OPENCODE_COMMAND = resolve(process.cwd(), "node_modules", ".bin", "opencode");
const REQUEST_TIMEOUT_MS = 10_000;

function discoverOpenCodeSkills(
  cwd: string,
  homePath: string,
): {
  location: string;
  name: string;
}[] {
  const result = spawnSync(OPENCODE_COMMAND, ["debug", "skill", "--pure"], {
    cwd,
    encoding: "utf8",
    env: {
      HOME: homePath,
      OPENCODE_TEST_HOME: homePath,
      PATH: process.env["PATH"] ?? "",
      XDG_CACHE_HOME: join(homePath, ".cache"),
      XDG_CONFIG_HOME: join(homePath, ".config"),
      XDG_DATA_HOME: join(homePath, ".local", "share"),
      XDG_STATE_HOME: join(homePath, ".local", "state"),
    },
    timeout: REQUEST_TIMEOUT_MS,
  });

  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as { location: string; name: string }[];
}

async function requestWithTimeout<T>(
  connection: ClientConnection,
  label: string,
  request: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const result = await settlePromiseWithTimeout(request(controller.signal), {
    label,
    timeoutMs: REQUEST_TIMEOUT_MS,
  });

  if (result.status === "completed") {
    return result.value;
  }

  controller.abort(result.error);

  if (result.status === "timed_out") {
    connection.close(result.error);
  }

  throw result.error;
}

async function stopOpenCode(
  connection: ClientConnection,
  child: ChildProcessWithoutNullStreams,
  closed: Promise<void>,
): Promise<void> {
  connection.close(new Error("OpenCode ACP contract test stopped."));

  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill("SIGTERM");
  const stopped = await settlePromiseWithTimeout(closed, {
    label: "OpenCode ACP contract process exit",
    timeoutMs: 2_000,
  });

  if (stopped.status === "timed_out") {
    child.kill("SIGKILL");
    await settlePromiseWithTimeout(closed, {
      label: "OpenCode ACP contract process force exit",
      timeoutMs: 1_000,
    });
  }
}

test("OpenCode rejects unadvertised additional directories before session creation", async () => {
  expect(existsSync(OPENCODE_COMMAND)).toBe(true);

  const root = await mkdtemp(join(tmpdir(), "agent-driver-opencode-acp-contract-"));
  const additionalDirectory = join(root, "additional");
  const cwd = join(root, "workspace");
  const homePath = join(root, "home");
  await Promise.all(
    [additionalDirectory, cwd, homePath].map((path) => mkdir(path, { recursive: true })),
  );

  const child = spawn(OPENCODE_COMMAND, ["acp", "--pure"], {
    cwd,
    env: {
      HOME: homePath,
      PATH: process.env["PATH"] ?? "",
      XDG_CACHE_HOME: join(homePath, ".cache"),
      XDG_CONFIG_HOME: join(homePath, ".config"),
      XDG_DATA_HOME: join(homePath, ".local", "share"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  const closed = new Promise<void>((resolveClosed) => child.once("close", () => resolveClosed()));
  const output = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
  const input = limitAcpInput(
    Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
  );
  const connection = createAcpClient({ name: "mosoo-driver-contract-test" }).connect(
    ndJsonStream(output, input),
  );
  child.stderr.resume();

  try {
    const initialize = await requestWithTimeout(
      connection,
      "OpenCode ACP initialize",
      (cancellationSignal) =>
        connection.agent.request(
          acpMethods.agent.initialize,
          {
            clientCapabilities: buildClientCapabilities(),
            clientInfo: {
              name: "mosoo-driver-contract-test",
              title: "Mosoo Driver Contract Test",
              version: "0.1.0",
            },
            protocolVersion: ACP_PROTOCOL_VERSION,
          },
          { cancellationSignal },
        ),
    );
    assertProtocolVersion(initialize);
    expect(
      initialize.agentCapabilities?.sessionCapabilities?.additionalDirectories,
    ).toBeUndefined();

    const sessionContext = {
      ...driverBootPayload.execution.session.context,
      homePath,
      sessionOrganizationPath: cwd,
    };
    const payload: DriverStartInput = {
      ...driverStartInput,
      execution: {
        ...driverStartInput.execution,
        session: {
          ...driverStartInput.execution.session,
          additionalDirectories: [additionalDirectory],
          context: sessionContext,
          cwd,
          homePath,
          sharedRootPath: cwd,
        },
      },
      runtime: "acp-fallback",
      runtimeTransport: "acp-fallback",
    };
    await expect(
      setupAcpSession({
        agentCapabilities: initialize.agentCapabilities ?? null,
        connection: connection.agent,
        currentSessionId: null,
        payload,
        replaySession: async (operation) => operation(),
      }),
    ).rejects.toThrow("does not advertise additionalDirectories support");
  } finally {
    await stopOpenCode(connection, child, closed);
    await rm(root, { force: true, recursive: true });
  }
});

test("OpenCode discovers a materialized native skill before its first process starts", async () => {
  expect(existsSync(OPENCODE_COMMAND)).toBe(true);

  const root = await mkdtemp(join(tmpdir(), "agent-driver-opencode-skill-contract-"));
  const homePath = join(root, "home");
  const mountPath = join(root, ".mosoo", "skill", "skill-1");
  const skillMarkdownPath = join(mountPath, "SKILL.md");
  await Promise.all([homePath, mountPath].map((path) => mkdir(path, { recursive: true })));
  await writeFile(
    skillMarkdownPath,
    `---
name: review
description: Review code changes.
---

Check the diff.`,
    "utf8",
  );
  const execution = {
    ...driverStartInput.execution,
    session: {
      ...driverStartInput.execution.session,
      cwd: root,
      homePath,
      sharedRootPath: root,
    },
  };
  const logger = createDisabledLogger();

  try {
    await exposeNativeSkillAliases(
      execution,
      logger,
      [
        {
          mountPath,
          skillId: "skill-1",
          skillMarkdownPath,
          skillName: "review",
          snapshotId: "snapshot-1",
        },
      ],
      new AbortController().signal,
    );

    const expectedSkillPath = join(await realpath(root), ".agents", "skills", "review", "SKILL.md");
    expect(discoverOpenCodeSkills(root, homePath)).toContainEqual(
      expect.objectContaining({
        location: expectedSkillPath,
        name: "review",
      }),
    );

    await exposeNativeSkillAliases(execution, logger, [], new AbortController().signal);

    expect(discoverOpenCodeSkills(root, homePath).some((skill) => skill.name === "review")).toBe(
      false,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("OpenCode resumes exported native history and Git snapshots after deleting its home", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-native-restore-contract-"));
  const cwd = join(root, "workspace");
  const homePath = join(root, "home");
  await mkdir(cwd);
  await mkdir(homePath);
  expect(spawnSync("git", ["init", "--quiet"], { cwd }).status).toBe(0);
  await writeFile(join(cwd, "history.txt"), "native snapshot continuity");
  expect(spawnSync("git", ["add", "history.txt"], { cwd }).status).toBe(0);
  expect(
    spawnSync(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "--quiet",
        "-m",
        "test: seed native fixture",
      ],
      { cwd },
    ).status,
  ).toBe(0);
  const dataPath = openCodeDataPath(homePath);
  const requests: Record<string, unknown>[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Record<string, unknown>;
      requests.push(body);
      const message = "native continuity proof";
      if (body["stream"] === true) {
        const chunks = [
          {
            id: "chatcmpl-fixture",
            object: "chat.completion.chunk",
            created: 1,
            model: "fixture",
            choices: [
              { index: 0, delta: { role: "assistant", content: message }, finish_reason: null },
            ],
          },
          {
            id: "chatcmpl-fixture",
            object: "chat.completion.chunk",
            created: 1,
            model: "fixture",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 17, completion_tokens: 3, total_tokens: 20 },
          },
        ];
        return new Response(
          chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return Response.json({
        id: "chatcmpl-fixture",
        object: "chat.completion",
        created: 1,
        model: "fixture",
        choices: [
          { index: 0, message: { role: "assistant", content: message }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 17, completion_tokens: 3, total_tokens: 20 },
      });
    },
  });
  const config = JSON.stringify({
    model: "fixture/fixture",
    small_model: "fixture/fixture",
    provider: {
      fixture: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "fixture" },
        models: { fixture: { name: "fixture", limit: { context: 8192, output: 1024 } } },
      },
    },
  });
  const events: DriverEventInput[] = [];
  let activeRunId: RunId | null = null;
  let seq = 0;
  const launch = async (nativeCheckpoint: NativeCheckpoint | null = null) => {
    const payload: DriverStartInput = {
      ...driverStartInput,
      execution: {
        ...driverStartInput.execution,
        environment: { variables: { OPENCODE_CONFIG_CONTENT: config } },
        session: {
          ...driverStartInput.execution.session,
          context: {
            ...driverStartInput.execution.session.context,
            homePath,
            sessionOrganizationPath: cwd,
          },
          cwd,
          homePath,
          sharedRootPath: cwd,
          nativeCheckpoint,
          nativeResumeRef: nativeCheckpoint?.nativeRef ?? null,
        },
      },
      runtime: "acp-fallback",
      runtimeTransport: "acp-fallback",
    };
    const context = createAgentDriverContext({
      payload,
      logger: createDisabledLogger(),
      permission: { request: async () => "allow_once" },
      ports: { skill: { materialize: async () => [] } },
      eventSink: {
        currentRunId: () => activeRunId,
        pushEvents: async (input) => {
          events.push(...input.events);
          return {
            accepted: input.events.map((event) => ({
              eventId: event.sourceEventId ?? event.id!,
              seq: ++seq,
              type: event.kind,
            })),
          };
        },
      },
    });
    const backend = new AcpDriverBackend(payload);
    await backend.start(context, new AbortController().signal);
    return { backend, context };
  };
  const prompt = async (
    runtime: Awaited<ReturnType<typeof launch>>,
    runId: RunId,
    text: string,
  ) => {
    activeRunId = runId;
    try {
      await runtime.backend.handleInput(runtime.context, { text }, runId);
    } finally {
      activeRunId = null;
    }
    const runEvents = events.filter((event) => event.runId === runId);
    const terminal = runEvents.find((event) => event.kind === "run.completed");
    if (terminal === undefined) throw new Error("OpenCode Run did not complete.");
    const checkpoint = parseNativeCheckpoint(
      (terminal.payload as Record<string, unknown>)["checkpoint"],
    );
    const resumes = runEvents.filter((event) => event.kind === "runtime.resume.updated");
    expect(resumes).toHaveLength(1);
    expect(resumes[0]?.payload).toEqual({ resumePointer: checkpoint.nativeRef.value });
    expect(runEvents.indexOf(resumes[0]!)).toBeLessThan(runEvents.indexOf(terminal!));
    const usage = runEvents.find((event) => event.kind === "usage.updated")?.payload as {
      inputTokens: number;
      outputTokens: number;
    };
    expect(usage.inputTokens).toBeGreaterThan(0);
    expect(usage.outputTokens).toBeGreaterThan(0);
    return checkpoint;
  };
  const previousCommand = process.env["MOSOO_ACP_FALLBACK_COMMAND"];
  const previousArgs = process.env["MOSOO_ACP_FALLBACK_ARGS"];
  process.env["MOSOO_ACP_FALLBACK_COMMAND"] = OPENCODE_COMMAND;
  process.env["MOSOO_ACP_FALLBACK_ARGS"] = JSON.stringify(["acp", "--pure"]);
  let runtime: Awaited<ReturnType<typeof launch>> | null = null;
  try {
    runtime = await launch();
    const first = await prompt(
      runtime,
      DRIVER_TEST_IDS.runId,
      "Remember the secret word continuity.",
    );
    const second = await prompt(runtime, DRIVER_TEST_IDS.secondRunId, "Continue the conversation.");
    expect(second.nativeRef).toEqual(first.nativeRef);
    await runtime.backend.stop(runtime.context, "restore fixture", new AbortController().signal);
    runtime = null;
    await rm(homePath, { force: true, recursive: true });
    runtime = await launch(second);
    using restored = new Database(join(dataPath, "opencode.db"), { readonly: true });
    expect(
      restored
        .query("SELECT count(*) AS count FROM message WHERE session_id = ?")
        .get(second.nativeRef.value),
    ).toMatchObject({ count: 4 });
    requests.length = 0;
    const resumed = await prompt(
      runtime,
      DRIVER_TEST_IDS.thirdRunId,
      "Continue with the previous answer.",
    );
    expect(resumed.nativeRef).toEqual(first.nativeRef);
    expect(
      requests.some((request) =>
        JSON.stringify(request["messages"]).includes("native continuity proof"),
      ),
    ).toBe(true);
    const sealed = await readNativeCheckpoint({ cwd, checkpoint: resumed });
    const snapshotFile = sealed.manifest.files.find(
      (file) => file.path.startsWith("snapshot/") && file.path.endsWith(".pack"),
    );
    expect(snapshotFile).toBeDefined();
    const snapshotDirectory = join(dataPath, ...snapshotFile!.path.split("/").slice(0, 3));
    const row = restored
      .query<{ snapshot: string }, []>(
        "SELECT json_extract(data, '$.snapshot') AS snapshot FROM part WHERE json_extract(data, '$.type') = 'step-finish' ORDER BY time_created DESC LIMIT 1",
      )
      .get();
    const tree = spawnSync(
      "git",
      ["--git-dir", snapshotDirectory, "ls-tree", "-r", "--name-only", row!.snapshot],
      { cwd, encoding: "utf8" },
    );
    expect(tree.status).toBe(0);
    expect(tree.stdout).toContain("history.txt");
    expect(tree.stdout).not.toContain(".state/native-checkpoints/");
  } finally {
    if (runtime !== null) {
      await runtime.backend.stop(runtime.context, "fixture complete", new AbortController().signal);
    }
    if (previousCommand === undefined) delete process.env["MOSOO_ACP_FALLBACK_COMMAND"];
    else process.env["MOSOO_ACP_FALLBACK_COMMAND"] = previousCommand;
    if (previousArgs === undefined) delete process.env["MOSOO_ACP_FALLBACK_ARGS"];
    else process.env["MOSOO_ACP_FALLBACK_ARGS"] = previousArgs;
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
