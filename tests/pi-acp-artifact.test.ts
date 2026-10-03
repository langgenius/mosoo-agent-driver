import { expect, test } from "bun:test";
import { zipSync } from "fflate";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { DriverEvent } from "../src/protocol/events";
import { isRecord } from "../src/runtimes/acp/acp-types";
import {
  DriverArtifactTestController,
  expectedDriverCapabilities,
} from "./driver-artifact-test-controller";
import { driverBootPayload, DRIVER_TEST_IDS } from "./driver-boot-payload-fixture";
import { piInput } from "./fixtures/pi-acp/input";

// Run inside the production Pi image with loopback-only container networking.
// No launch spies: the packed Driver owns the installed adapter and native Pi.
const artifactTest = process.env["PI_ACP_ARTIFACT_CONTRACT"] === "1" ? test : test.skip;
const TIMEOUT = 60_000;
const MODEL = "gpt-6-astra";
type Step = { text?: string; tool?: string; length?: boolean; httpError?: boolean };

async function createArtifactFixture() {
  if (process.platform !== "linux") throw new Error("Packed Pi contract requires Linux /proc");
  const artifactPath = process.env["PI_ACP_ARTIFACT_PATH"] ?? "/usr/local/bin/agent-driver";
  for (const executable of [
    artifactPath,
    "/usr/local/bin/pi-acp",
    "/usr/local/bin/mosoo-pi",
    "/usr/local/bin/pi",
  ]) {
    if (!existsSync(executable)) throw new Error(`Packed Pi contract missing ${executable}`);
  }
  // The acceptance result applies to the exact current build, not an older image.
  const sourceArtifact = resolve(import.meta.dir, "../dist/driver.mjs");
  expect(Buffer.compare(await readFile(artifactPath), await readFile(sourceArtifact))).toBe(0);
  const rootPath = await mkdtemp(join(tmpdir(), "pi-acp-artifact-"));
  const homePath = join(rootPath, "home");
  const workspacePath = join(rootPath, "workspace");
  await Promise.all([homePath, workspacePath].map((path) => mkdir(path, { recursive: true })));
  const skillName = "artifact-selected";
  const mountPath = join(workspacePath, ".mosoo", "skill", skillName);
  const archive = zipSync({
    "SKILL.md": new TextEncoder().encode(
      "---\nname: artifact-selected\ndescription: PI_ARTIFACT_SELECTED_SKILL_DESCRIPTION\n---\nPI_ARTIFACT_SELECTED_SKILL_BODY\n",
    ),
  });
  const restoredSkill = join(homePath, "pi-acp/.pi/agent/skills/restored");
  await mkdir(restoredSkill, { recursive: true });
  await writeFile(
    join(restoredSkill, "SKILL.md"),
    "---\nname: restored-unselected\ndescription: PI_ARTIFACT_UNSELECTED_SKILL\n---\nRestored ambient skill\n",
  );
  const steps: Step[] = [];
  const requests: Array<{ messages: unknown; model: string }> = [];
  const errors: string[] = [];
  let grant = "";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      try {
        if (
          new URL(request.url).pathname !==
          "/api/driver/llm/proxy/artifact-fixture/chat/completions"
        )
          throw new Error("Unexpected model URL");
        if (request.headers.get("authorization") !== `Bearer ${grant}`)
          throw new Error("Unexpected model grant");
        const body = (await request.json()) as { messages: unknown; model: string };
        requests.push(body);
        if (body.model !== MODEL) throw new Error("Unexpected selected model");
        const step = steps.shift();
        if (!step) throw new Error("Unscripted model request");
        if (step.httpError) return new Response("PI_ARTIFACT_PROVIDER_HTTP500", { status: 500 });
        const chunks: string[] = [];
        const frame = (delta: Record<string, unknown>, finish: string | null = null) =>
          chunks.push(
            `data: ${JSON.stringify({ id: `artifact-${requests.length}`, object: "chat.completion.chunk", created: 1, model: MODEL, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
          );
        frame({ role: "assistant" });
        if (step.text) frame({ content: step.text });
        if (step.tool)
          frame({
            tool_calls: [
              {
                index: 0,
                id: `tool-${requests.length}`,
                type: "function",
                function: {
                  name: "bash",
                  arguments: JSON.stringify({ command: `printf ${step.tool}` }),
                },
              },
            ],
          });
        frame({}, step.length ? "length" : step.tool ? "tool_calls" : "stop");
        chunks.push("data: [DONE]\n\n");
        return new Response(chunks.join(""), { headers: { "content-type": "text/event-stream" } });
      } catch (error) {
        errors.push(String(error));
        return new Response("PI_ARTIFACT_FIXTURE_REJECTED", { status: 500 });
      }
    },
  });
  const controllers: DriverArtifactTestController[] = [];
  return {
    steps,
    requests,
    errors,
    async start(
      nativeResumeRef: { runtimeId: "pi-acp"; kind: "acp_session_id"; value: string } | null = null,
      selectedSkill = false,
    ) {
      const input = piInput({
        model: MODEL,
        resourceId: "artifact-fixture",
        baseUrl: `http://127.0.0.1:${server.port}/api/driver/llm/proxy/artifact-fixture`,
        expiresAt: Date.now() + 120_000,
      });
      grant = input.execution.environment.variables["OPENAI_COMPATIBLE_API_KEY"]!;
      const controller = await DriverArtifactTestController.start({
        artifactPath,
        bootPayload: {
          ...driverBootPayload,
          runtime: "pi-acp",
          runtimeTransport: "pi-acp",
          execution: {
            ...driverBootPayload.execution,
            configRevision: { ...driverBootPayload.execution.configRevision, runId: null },
            provider: input.execution.provider,
            model: input.execution.model,
            environment: input.execution.environment,
            providerOptions: { pi: { thinkingLevel: "off" } },
            skillCatalog: selectedSkill
              ? [
                  {
                    frontmatter: {
                      author: null,
                      description: "PI_ARTIFACT_SELECTED_SKILL_DESCRIPTION",
                      version: null,
                    },
                    mountPath,
                    resolutionMode: "explicit",
                    skillId: "01J00000000000000000000020",
                    skillName,
                  },
                ]
              : [],
            skills: selectedSkill
              ? [
                  {
                    archiveFormat: "zip",
                    blobSha256: createHash("sha256").update(archive).digest("hex"),
                    compression: "deflate",
                    downloadUrl: `data:application/zip;base64,${Buffer.from(archive).toString("base64")}`,
                    materializationStatus: "pending",
                    mountPath,
                    resolutionMode: "explicit",
                    skillId: "01J00000000000000000000020",
                    skillName,
                    snapshotId: "01J00000000000000000000021",
                    warningCode: null,
                  },
                ]
              : [],
            session: {
              ...driverBootPayload.execution.session,
              cwd: workspacePath,
              context: {
                ...driverBootPayload.execution.session.context,
                homePath,
                sessionOrganizationPath: workspacePath,
              },
              nativeResumeRef,
            },
          },
        },
        env: { OPENAI_API_KEY: "", OPENROUTER_API_KEY: "", ANTHROPIC_API_KEY: "" },
        expectedCapabilities: expectedDriverCapabilities("pi-acp"),
        forbiddenSecrets: [grant],
        organizationPath: workspacePath,
        rootPath,
        startTimeoutMs: TIMEOUT,
      });
      controllers.push(controller);
      return controller;
    },
    async cleanup() {
      try {
        for (const controller of controllers) await controller.dispose();
      } finally {
        await server.stop(true);
        await rm(rootPath, { recursive: true, force: true });
      }
    },
  };
}

async function runOutcome(
  controller: DriverArtifactTestController,
  runId: string,
  status: "completed" | "failed",
) {
  const index = controller.events.length;
  const commandId = `artifact-input-${runId}`;
  controller.enqueue({
    commandId,
    requestId: `request-${runId}`,
    kind: "input.start",
    input: { text: "Perform the requested fixture task" },
    runId,
  });
  const [update] = await Promise.all([
    controller.waitForCommandTerminal(commandId, TIMEOUT),
    controller.waitForEvent(
      (event) =>
        event.runId === runId &&
        ["run.completed", "run.failed", "run.cancelled"].includes(event.kind),
      index,
      TIMEOUT,
      "packed Pi run terminal",
    ),
  ]);
  await Bun.sleep(100);
  const events = controller.eventsSince(index);
  expect(update.status).toBe(status);
  expect(
    events
      .filter((event) => ["run.completed", "run.failed", "run.cancelled"].includes(event.kind))
      .map((event) => event.kind),
  ).toEqual([`run.${status}`]);
  return events;
}

function terminalPayload(events: readonly DriverEvent[]) {
  return events.find((event) => event.kind === "run.failed")?.payload;
}

artifactTest(
  "Given the production packed Pi Driver executes a native tool, When the next model request and all native retries return HTTP500, Then its protocol retains the original failure",
  async () => {
    const fixture = await createArtifactFixture();
    try {
      const controller = await fixture.start();
      // Pi 1.0 defaults to three agent retries with 2-second base delay.
      // Exercise production retry policy with the initial failure and all retries.
      fixture.steps.push(
        { tool: "PI_ARTIFACT_TOOL_BEFORE_ERROR" },
        ...Array.from({ length: 4 }, (): Step => ({ httpError: true })),
      );
      const events = await runOutcome(controller, DRIVER_TEST_IDS.runId, "failed");
      expect(fixture.requests).toHaveLength(5);
      expect(JSON.stringify(events)).toContain("PI_ARTIFACT_TOOL_BEFORE_ERROR");
      expect(
        events.some(
          (event) =>
            event.kind === "tool.call.updated" &&
            isRecord(event.payload) &&
            event.payload["status"] === "completed",
        ),
      ).toBe(true);
      const failure = JSON.stringify(terminalPayload(events));
      expect(failure).toContain("PI_ARTIFACT_PROVIDER_HTTP500");
      expect(JSON.stringify(events)).not.toMatch(/resuming/i);
      expect(fixture.errors).toEqual([]);
      expect(fixture.steps).toEqual([]);
      // Main treats input.start failures as fatal and reports failure before exiting.
      expect((await controller.waitForRunTerminal(TIMEOUT)).status).toBe("failed");
      expect(await controller.waitForExit(TIMEOUT)).toMatchObject({ code: 1, signal: null });
    } finally {
      await fixture.cleanup();
    }
  },
  120_000,
);

artifactTest(
  "Given the production packed Pi Driver receives partial text, When streaming ends with length, Then its protocol fails with max_tokens",
  async () => {
    const fixture = await createArtifactFixture();
    try {
      const controller = await fixture.start();
      fixture.steps.push({ text: "PI_ARTIFACT_TRUNCATED_PREFIX", length: true });
      const events = await runOutcome(controller, DRIVER_TEST_IDS.runId, "failed");
      expect(fixture.requests).toHaveLength(1);
      expect(JSON.stringify(events)).toContain("PI_ARTIFACT_TRUNCATED_PREFIX");
      expect(JSON.stringify(terminalPayload(events))).toContain("max_tokens");
      expect(fixture.errors).toEqual([]);
      // A failed input command follows Main's fatal-exit contract.
      expect((await controller.waitForRunTerminal(TIMEOUT)).status).toBe("failed");
      expect(await controller.waitForExit(TIMEOUT)).toMatchObject({ code: 1, signal: null });
    } finally {
      await fixture.cleanup();
    }
  },
  120_000,
);

artifactTest(
  "Given the production packed Pi Driver finishes native tool and text output, When a fresh Driver cold loads with its selected skill revoked, Then prior context survives without replay or stale skills",
  async () => {
    const fixture = await createArtifactFixture();
    try {
      const first = await fixture.start(null, true);
      fixture.steps.push({ tool: "PI_ARTIFACT_NATIVE_TOOL" }, { text: "PI_ARTIFACT_FIRST_DONE" });
      const firstEvents = await runOutcome(first, DRIVER_TEST_IDS.runId, "completed");
      expect(JSON.stringify(firstEvents)).toContain("PI_ARTIFACT_NATIVE_TOOL");
      expect(JSON.stringify(firstEvents)).toContain("PI_ARTIFACT_FIRST_DONE");
      const firstMessages = fixture.requests[0]?.messages;
      if (!Array.isArray(firstMessages)) throw new Error("Missing first model messages");
      const firstSystem = JSON.stringify(
        firstMessages.filter((message) => isRecord(message) && message["role"] === "system"),
      );
      expect(firstSystem).toContain("PI_ARTIFACT_SELECTED_SKILL_DESCRIPTION");
      expect(firstSystem).not.toContain("PI_ARTIFACT_UNSELECTED_SKILL");
      const pointerPayload = first.events.find(
        (event) => event.kind === "runtime.resume.updated",
      )?.payload;
      const pointer = isRecord(pointerPayload) ? pointerPayload["resumePointer"] : undefined;
      if (typeof pointer !== "string")
        throw new Error("Packed Pi omitted its native session pointer");
      await first.stopDriver("stop-before-cold", TIMEOUT);
      const cold = await fixture.start({
        runtimeId: "pi-acp",
        kind: "acp_session_id",
        value: pointer,
      });
      expect(JSON.stringify(cold.events)).not.toContain("PI_ARTIFACT_FIRST_DONE");
      fixture.steps.push({ text: "PI_ARTIFACT_COLD_DONE" });
      const coldEvents = await runOutcome(cold, DRIVER_TEST_IDS.secondRunId, "completed");
      expect(JSON.stringify(coldEvents)).toContain("PI_ARTIFACT_COLD_DONE");
      expect(JSON.stringify(fixture.requests.at(-1)?.messages)).toContain("PI_ARTIFACT_FIRST_DONE");
      const coldMessages = fixture.requests.at(-1)?.messages;
      if (!Array.isArray(coldMessages)) throw new Error("Missing cold model messages");
      const coldSystem = JSON.stringify(
        coldMessages.filter((message) => isRecord(message) && message["role"] === "system"),
      );
      expect(coldSystem).not.toContain("PI_ARTIFACT_SELECTED_SKILL_DESCRIPTION");
      expect(coldSystem).not.toContain("PI_ARTIFACT_UNSELECTED_SKILL");
      expect(fixture.requests).toHaveLength(3);
      expect(fixture.errors).toEqual([]);
      await cold.stopDriver("stop-cold", TIMEOUT);
    } finally {
      await fixture.cleanup();
    }
  },
  120_000,
);
