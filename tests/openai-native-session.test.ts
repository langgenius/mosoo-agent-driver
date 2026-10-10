import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createDriverId } from "../src/protocol/id";
import { parseNativeCheckpoint, type NativeCheckpoint } from "../src/protocol/native-checkpoint";
import { readNativeCheckpoint } from "../src/runtimes/native-checkpoint";
import {
  DriverArtifactTestController,
  expectedDriverCapabilities,
} from "./driver-artifact-test-controller";
import { DRIVER_TEST_IDS, driverBootPayload } from "./driver-boot-payload-fixture";
import { messageText } from "./driver-event-test-helpers";

const nativeTest = process.env["AGENT_DRIVER_NATIVE_OPENAI"] === "1" ? test : test.skip;
const artifactPath =
  process.env["MOSOO_OPENAI_TEST_ARTIFACT"] ??
  fileURLToPath(new URL("../dist/driver.mjs", import.meta.url));
const codexCli = fileURLToPath(
  new URL("../node_modules/@openai/codex/bin/codex.js", import.meta.url),
);
const grant = "local-openai-native-fixture-grant";
const prompts = [
  "Remember native-user-one.",
  "Remember native-user-two.",
  "Recall our restored conversation.",
];

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

nativeTest(
  "packed OpenAI Driver checkpoints two warm turns and resumes in a fresh native home",
  async () => {
    if (!existsSync(artifactPath))
      throw new Error("Build the Driver artifact before running the native OpenAI test.");
    const node = Bun.which("node");
    if (node === null) throw new Error("Native OpenAI test requires Node.js.");
    const root = await mkdtemp("/tmp/driver-openai-native-");
    const workspace = join(root, "workspace");
    const firstHome = join(root, "first-home");
    const secondHome = join(root, "second-home");
    const launches = join(root, "native-launches");
    const executable = join(root, "codex-fixture");
    const requests: unknown[] = [];
    const model = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        expect(new URL(request.url).pathname).toBe("/v1/responses");
        expect(request.headers.get("authorization")).toBe(`Bearer ${grant}`);
        const body = await request.json();
        requests.push(body);
        const index = requests.length;
        const item = {
          type: "message",
          id: `msg_native_${index}`,
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: `native-reply-${index}`, annotations: [] }],
        };
        const records = [
          {
            type: "response.created",
            response: { id: `resp_native_${index}`, status: "in_progress", output: [] },
          },
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { ...item, status: "in_progress", content: [] },
          },
          {
            type: "response.content_part.added",
            output_index: 0,
            content_index: 0,
            item_id: item.id,
            part: { type: "output_text", text: "", annotations: [] },
          },
          {
            type: "response.output_text.delta",
            output_index: 0,
            content_index: 0,
            item_id: item.id,
            delta: `native-reply-${index}`,
          },
          { type: "response.output_item.done", output_index: 0, item },
          {
            type: "response.completed",
            response: {
              id: `resp_native_${index}`,
              status: "completed",
              output: [item],
              usage: {
                input_tokens: 3,
                output_tokens: 3,
                total_tokens: 6,
                input_tokens_details: { cached_tokens: 0 },
              },
            },
          },
        ];
        return new Response(
          records
            .map((record) => `event: ${record.type}\ndata: ${JSON.stringify(record)}\n\n`)
            .join(""),
          {
            headers: { "Content-Type": "text/event-stream" },
          },
        );
      },
    });
    let controller: DriverArtifactTestController | null = null;
    try {
      await mkdir(workspace);
      // Isolate this native fixture from host-only experimental config and remote MCP services.
      await writeFile(
        executable,
        `#!/bin/sh\nprintf '%s\\n' "$$" >> ${shellQuote(launches)}\nexec ${shellQuote(node)} ${shellQuote(codexCli)} "$@" -c 'features.context_management=false' -c 'mcp_servers.openaiDeveloperDocs.enabled=false' -c 'mcp_servers.anysearch.enabled=false'\n`,
      );
      await chmod(executable, 0o755);
      const start = (homePath: string, checkpoint: NativeCheckpoint | null) =>
        DriverArtifactTestController.start({
          artifactPath,
          bootPayload: {
            ...driverBootPayload,
            driverInstanceId: createDriverId(),
            execution: {
              ...driverBootPayload.execution,
              configRevision: { ...driverBootPayload.execution.configRevision, runId: null },
              provider: "openai-compatible",
              model: "gpt-5.4",
              environment: {
                variables: {
                  OPENAI_COMPATIBLE_API_KEY: grant,
                  OPENAI_COMPATIBLE_BASE_URL: `${model.url.origin}/v1`,
                },
              },
              session: {
                ...driverBootPayload.execution.session,
                cwd: workspace,
                nativeCheckpoint: checkpoint,
                nativeResumeRef: checkpoint?.nativeRef ?? null,
                context: {
                  ...driverBootPayload.execution.session.context,
                  homePath,
                  sessionOrganizationPath: workspace,
                },
              },
            },
          },
          env: {
            MOSOO_OPENAI_RUNTIME_EXECUTABLE: executable,
            OPENAI_API_KEY: "",
            ANTHROPIC_API_KEY: "",
            OPENROUTER_API_KEY: "",
          },
          expectedCapabilities: expectedDriverCapabilities("openai-runtime"),
          forbiddenSecrets: [grant],
          organizationPath: workspace,
          rootPath: root,
          startTimeoutMs: 20_000,
        });
      let previousCheckpoint: NativeCheckpoint | null = null;
      const run = async (active: DriverArtifactTestController, index: number) => {
        const runId = [
          DRIVER_TEST_IDS.runId,
          DRIVER_TEST_IDS.secondRunId,
          DRIVER_TEST_IDS.thirdRunId,
        ][index]!;
        const gate = active.gateEventIngress(
          (event) => event.kind === "run.completed" && event.runId === runId,
        );
        const running = active.runTurn({
          commandId: `native-command-${index}`,
          requestId: `native-request-${index}`,
          runId,
          text: prompts[index]!,
          timeoutMs: 20_000,
        });
        void running.catch(() => {});
        let checkpoint: NativeCheckpoint;
        try {
          const terminal = await Promise.race([
            gate.entered,
            running.then(() => {
              throw new Error("Completed event bypassed its ingress gate.");
            }),
          ]);
          const completion = terminal.payload as { checkpoint: unknown; finalMessageId: string };
          checkpoint = parseNativeCheckpoint(completion.checkpoint);
          expect(checkpoint.runId).toBe(runId);
          expect(checkpoint.nativeRef).toMatchObject({
            runtimeId: "openai-runtime",
            kind: "openai_thread_id",
          });
          if (previousCheckpoint !== null)
            expect(checkpoint.nativeRef).toEqual(previousCheckpoint.nativeRef);
          // Inspect the immutable bundle before the host sends the terminal receipt.
          const saved = await readNativeCheckpoint({ cwd: workspace, checkpoint });
          const rollout = saved.manifest.files.find(
            (file) => file.path.startsWith("sessions/") && file.path.endsWith(".jsonl"),
          );
          expect(rollout).toBeDefined();
          const content = (await saved.readFile(rollout!.path)).toString();
          const records = content
            .trimEnd()
            .split("\n")
            .map((line) => JSON.parse(line));
          expect(records[0]).toMatchObject({
            type: "session_meta",
            payload: { id: checkpoint.nativeRef.value },
          });
          expect(records.at(-1)).toMatchObject({
            type: "event_msg",
            payload: { type: "task_complete" },
          });
          for (let prior = 0; prior <= index; prior++) {
            expect(content).toContain(prompts[prior]!);
            expect(content).toContain(`native-reply-${prior + 1}`);
          }
          expect(
            active.commandUpdates.some(
              (update) =>
                update.commandId === `native-command-${index}` && update.status === "completed",
            ),
          ).toBe(false);
        } finally {
          gate.release();
        }
        const events = await running;
        const completion = events.find((event) => event.kind === "run.completed")!.payload as {
          finalMessageId: string;
        };
        expect(messageText(events, completion.finalMessageId)).toBe(`native-reply-${index + 1}`);
        previousCheckpoint = checkpoint;
        return checkpoint;
      };
      controller = await start(firstHome, null);
      await run(controller, 0);
      const checkpoint = await run(controller, 1);
      expect((await readFile(launches, "utf8")).trim().split("\n")).toHaveLength(1);
      expect(JSON.stringify(requests[1])).toContain(prompts[0]!);
      expect(JSON.stringify(requests[1])).toContain("native-reply-1");
      await controller.stopDriver("native-warm-stop", 15_000);
      await controller.dispose();
      controller = null;
      await rm(firstHome, { recursive: true });
      expect(existsSync(secondHome)).toBe(false);
      controller = await start(secondHome, checkpoint);
      await run(controller, 2);
      expect((await readFile(launches, "utf8")).trim().split("\n")).toHaveLength(2);
      expect(requests).toHaveLength(3);
      for (let index = 0; index < 2; index++) {
        expect(JSON.stringify(requests[2])).toContain(prompts[index]!);
        expect(JSON.stringify(requests[2])).toContain(`native-reply-${index + 1}`);
      }
      await controller.stopDriver("native-restored-stop", 15_000);
    } finally {
      await controller?.dispose();
      await model.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
  90_000,
);
