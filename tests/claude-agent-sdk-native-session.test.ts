import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentDriverContext } from "../src/core/agent-driver-backend";
import { DriverTurnCancelledError } from "../src/core/driver-runtime-state";
import { createDisabledLogger } from "../src/observability";
import type { RunId } from "../src/protocol/id";
import type { DriverStartInput } from "../src/protocol/start";
import { ClaudeAgentSdkDriverBackend } from "../src/runtimes/claude/agent-sdk-driver-backend";
import { createClaudeQueryOptions } from "../src/runtimes/claude/agent-sdk-query-options";
import { bootPayload, DRIVER_TEST_IDS } from "./driver-runtime-boundary-fixtures";

const nativeTest = process.env["AGENT_DRIVER_NATIVE_CLAUDE"] === "1" ? test : test.skip;

nativeTest(
  "native Claude reuses text turns, executes tools, and reaps cancelled tool trees",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "driver-claude-native-"));
    let toolCommand: string | null = null;
    let requestCount = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path.endsWith("/count_tokens")) {
          return Response.json({ input_tokens: 5 });
        }
        if (path !== "/v1/messages") {
          return Response.json({});
        }
        const body = (await request.json()) as { model: string; stream?: boolean };
        const command = toolCommand;
        toolCommand = null;
        requestCount += 1;
        const content =
          command === null
            ? { text: "OK", type: "text" }
            : { id: `tool_${requestCount}`, input: { command }, name: "Bash", type: "tool_use" };
        const stopReason = command === null ? "end_turn" : "tool_use";
        const message = {
          content: [content],
          id: `msg_${requestCount}`,
          model: body.model,
          role: "assistant",
          stop_reason: stopReason,
          stop_sequence: null,
          type: "message",
          usage: { input_tokens: 5, output_tokens: 1 },
        };
        if (body.stream !== true) return Response.json(message);
        const events = [
          {
            type: "message_start",
            message: {
              ...message,
              content: [],
              stop_reason: null,
              usage: { input_tokens: 5, output_tokens: 0 },
            },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block:
              command === null ? { type: "text", text: "" } : { ...content, input: {} },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta:
              command === null
                ? { type: "text_delta", text: "OK" }
                : { type: "input_json_delta", partial_json: JSON.stringify({ command }) },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: { output_tokens: 1 },
          },
          { type: "message_stop" },
        ];
        return new Response(
          events
            .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
            .join(""),
          {
            headers: { "Content-Type": "text/event-stream" },
          },
        );
      },
    });
    const samples: { mode: string; turn: number; firstTextMs: number; spawns: number }[] = [];
    const backends: {
      backend: ClaudeAgentSdkDriverBackend;
      context: ReturnType<typeof createAgentDriverContext>;
    }[] = [];
    try {
      for (const mode of ["one-shot", "persistent", "drain-fallback"]) {
        const cwd = join(root, mode);
        const homePath = join(cwd, "home");
        await mkdir(homePath, { recursive: true });
        const payload: DriverStartInput = {
          ...bootPayload,
          execution: {
            ...bootPayload.execution,
            builtInTools: [{ enabled: true, name: "bash" }],
            environment: {
              variables: {
                ANTHROPIC_API_KEY: "local-fixture-only",
                ANTHROPIC_BASE_URL: server.url.origin,
                CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
                DISABLE_ERROR_REPORTING: "1",
                DISABLE_TELEMETRY: "1",
              },
            },
            model: "claude-sonnet-4-5",
            provider: "anthropic",
            providerOptions: mode === "one-shot" ? { maxBudgetUsd: 1 } : {},
            session: {
              ...bootPayload.execution.session,
              additionalDirectories: [],
              cwd,
              homePath,
              mcpServers: [],
              nativeResumeRef: null,
              recoveryMessages: [],
              sharedRootPath: cwd,
            },
            skillCatalog: [],
            skills: [],
          },
          runtime: "claude-agent-sdk",
          runtimeTransport: "claude-agent-sdk",
        };
        let currentRunId: RunId | null = null;
        let firstTextMs: number | null = null;
        let startedAt = 0;
        let seq = 0;
        let spawns = 0;
        let permissions = 0;
        const pids: number[] = [];
        const terminals: string[] = [];
        let checkpointPrompt: string | null = null;
        const context = createAgentDriverContext({
          eventSink: {
            currentRunId: () => currentRunId,
            pushEvents: async ({ events }) => {
              for (const event of events) {
                if (event.kind === "message.delta") firstTextMs ??= performance.now() - startedAt;
                if (["run.completed", "run.cancelled", "run.failed"].includes(event.kind))
                  terminals.push(event.kind);
                if (event.kind === "run.completed" && checkpointPrompt !== null) {
                  let transcript = "";
                  for await (const file of new Bun.Glob("projects/*/*.jsonl").scan(homePath)) {
                    transcript += await readFile(join(homePath, file), "utf8");
                  }
                  // Check at terminal publication, before the host can checkpoint
                  // or acknowledge it. Waiting after handleInput would hide a race.
                  expect(transcript).toContain(checkpointPrompt);
                  const records = transcript
                    .trim()
                    .split("\n")
                    .map((line) => JSON.parse(line));
                  expect(
                    records.some(
                      (entry) =>
                        entry.type === "assistant" && entry.message?.id === `msg_${requestCount}`,
                    ),
                  ).toBe(true);
                }
              }
              return {
                accepted: events.map((event) => ({
                  eventId: event.sourceEventId!,
                  seq: ++seq,
                  type: event.kind,
                })),
              };
            },
          },
          logger: createDisabledLogger(),
          payload,
          permission: {
            request: async () => {
              permissions += 1;
              return "allow_once";
            },
          },
          ports: { skill: { materialize: async () => [] } },
        });
        const backend = new ClaudeAgentSdkDriverBackend(payload, {
          ...(mode === "drain-fallback" ? { waitForTranscript: async () => false } : {}),
          createQueryOptions: async (input) => {
            const options = await createClaudeQueryOptions(input);
            const spawn = options.spawnClaudeCodeProcess!;
            options.spawnClaudeCodeProcess = (args) => {
              spawns += 1;
              const child = spawn(args);
              if ("pid" in child && typeof child.pid === "number") pids.push(child.pid);
              return child;
            };
            return options;
          },
        });
        backends.push({ backend, context });
        await backend.start(context, AbortSignal.timeout(15_000));
        const run = async (runId: RunId, text = "Reply OK.") => {
          currentRunId = runId;
          firstTextMs = null;
          startedAt = performance.now();
          try {
            await backend.handleInput(context, { text }, runId, AbortSignal.timeout(20_000));
          } finally {
            currentRunId = null;
          }
        };
        for (const [index, runId] of [
          DRIVER_TEST_IDS.runId,
          DRIVER_TEST_IDS.secondRunId,
        ].entries()) {
          const before = spawns;
          checkpointPrompt = `Reply OK ${index + 1}.`;
          await run(runId, `Reply OK ${index + 1}.`);
          checkpointPrompt = null;
          expect(firstTextMs).not.toBeNull();
          samples.push({
            mode,
            turn: index + 1,
            firstTextMs: Math.round(firstTextMs!),
            spawns: spawns - before,
          });
        }
        expect(spawns).toBe(mode === "persistent" ? 1 : 2);
        expect(pids).toHaveLength(spawns);
        if (mode === "persistent") {
          toolCommand = "printf tool-ok > tool-marker";
          await run(DRIVER_TEST_IDS.thirdRunId, "Use Bash to write the marker.");
          expect(await readFile(join(cwd, "tool-marker"), "utf8")).toBe("tool-ok");
          expect(permissions).toBeGreaterThan(0);
          expect(spawns).toBe(1);
          expect(() => process.kill(pids[0]!, 0)).toThrow();
          toolCommand = "printf started > cancel-started; sleep 3; printf leaked > cancel-leaked";
          const cancellingRun = run(
            "01J00000000000000000000016" as RunId,
            "Use Bash for the delayed marker.",
          );
          void cancellingRun.catch(() => {});
          const deadline = Date.now() + 15_000;
          while (!(await Bun.file(join(cwd, "cancel-started")).exists())) {
            if (Date.now() > deadline) throw new Error("Native Bash tool did not start.");
            await Bun.sleep(20);
          }
          await backend.cancelActiveTurn(context, "test.cancel");
          await expect(cancellingRun).rejects.toBeInstanceOf(DriverTurnCancelledError);
          expect(pids).toHaveLength(2);
          expect(() => process.kill(pids[1]!, 0)).toThrow();
          await Bun.sleep(3_100);
          expect(
            await stat(join(cwd, "cancel-leaked")).then(
              () => true,
              () => false,
            ),
          ).toBe(false);
          await run("01J00000000000000000000017" as RunId);
          expect(spawns).toBe(3);
          expect(terminals).toEqual([
            "run.completed",
            "run.completed",
            "run.completed",
            "run.cancelled",
            "run.completed",
          ]);
        }
        await backend.stop(context, "test.complete", AbortSignal.timeout(10_000));
        expect(pids).toHaveLength(spawns);
        for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
      }
      console.log(JSON.stringify({ claudeSessionLifecycle: samples }));
    } finally {
      await Promise.all(
        backends.map(({ backend, context }) =>
          backend.stop(context, "test.cleanup", AbortSignal.timeout(10_000)),
        ),
      );
      server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
  90_000,
);
