import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseNativeCheckpoint } from "../src/protocol/native-checkpoint";

import {
  DriverArtifactTestController,
  expectedDriverCapabilities,
} from "./driver-artifact-test-controller";
import { DRIVER_TEST_IDS, driverBootPayload } from "./driver-boot-payload-fixture";
import { messageText } from "./driver-event-test-helpers";

const artifactPath =
  process.env["MOSOO_PI_TEST_ARTIFACT"] ??
  fileURLToPath(new URL("../dist/driver.mjs", import.meta.url));
const cli =
  process.env["MOSOO_PI_TEST_CLI"] ??
  join(
    dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
    "bundle",
    "cli.js",
  );

test.skipIf(!existsSync(artifactPath))(
  "packed Driver runs Pi through boot, control WebSocket, and canonical events",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "mosoo-pi-artifact-"));
    let modelCalls = 0;
    const model = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        expect(request.headers.get("authorization")).toBe("Bearer artifact-pi-grant");
        const body = await request.json();
        if (modelCalls >= 2) expect(JSON.stringify(body)).toContain("artifact-proof");
        const delta =
          ++modelCalls === 1
            ? {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "artifact-write",
                    type: "function",
                    function: {
                      name: "write",
                      arguments: JSON.stringify({ path: "proof.txt", content: "artifact-proof" }),
                    },
                  },
                ],
              }
            : { role: "assistant", content: "Pi artifact succeeded." };
        const chunk = (value: object, finish: string | null) =>
          `data: ${JSON.stringify({ id: "pi", choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`;
        return new Response(
          chunk(delta, null) +
            chunk({}, modelCalls === 1 ? "tool_calls" : "stop") +
            "data: [DONE]\n\n",
          { headers: { "Content-Type": "text/event-stream" } },
        );
      },
    });
    let controller: DriverArtifactTestController | null = null;
    try {
      const payload = {
        ...driverBootPayload,
        runtime: "pi",
        runtimeTransport: "pi-rpc",
        execution: {
          ...driverBootPayload.execution,
          provider: "deepseek",
          model: "pi-test",
          environment: {
            variables: {
              MOSOO_PI_PROXY_GRANT: "artifact-pi-grant",
              MOSOO_PI_CONFIG_CONTENT: JSON.stringify({
                providers: {
                  mosoo: {
                    api: "openai-completions",
                    baseUrl: `http://127.0.0.1:${model.port}/v1`,
                    apiKey: "${MOSOO_PI_PROXY_GRANT}",
                    models: [{ id: "pi-test" }],
                  },
                },
              }),
            },
          },
          session: {
            ...driverBootPayload.execution.session,
            cwd: root,
            context: {
              ...driverBootPayload.execution.session.context,
              homePath: root,
              sessionOrganizationPath: root,
            },
          },
        },
      };
      controller = await DriverArtifactTestController.start({
        artifactPath,
        bootPayload: payload,
        env: { MOSOO_PI_EXECUTABLE: "node", MOSOO_PI_ARGS: JSON.stringify([cli]) },
        expectedCapabilities: expectedDriverCapabilities("pi"),
        organizationPath: root,
        rootPath: root,
        forbiddenSecrets: ["artifact-pi-grant"],
        startTimeoutMs: 20_000,
      });
      const events = await controller.runTurn({
        commandId: "pi-input",
        requestId: "pi-request",
        runId: DRIVER_TEST_IDS.runId,
        text: "Write proof.txt.",
        timeoutMs: 20_000,
      });
      expect(await readFile(join(root, "proof.txt"), "utf8")).toBe("artifact-proof");
      const completion = events.find((event) => event.kind === "run.completed")?.payload as {
        finalMessageId: string;
        checkpoint: unknown;
      };
      expect(completion).not.toHaveProperty("finalMessageText");
      expect(
        messageText(
          events.filter((event) => event.kind === "message.added"),
          completion.finalMessageId,
        ),
      ).toBe("Pi artifact succeeded.");
      expect(events.some((event) => event.kind === "runtime.resume.updated")).toBe(true);
      const pointer = events.find((event) => event.kind === "runtime.resume.updated")?.payload as {
        resumePointer: string;
      };
      const checkpoint = parseNativeCheckpoint(completion.checkpoint);
      await controller.stopDriver("pi-stop", 15_000);
      await controller.dispose();
      controller = await DriverArtifactTestController.start({
        artifactPath,
        bootPayload: {
          ...payload,
          execution: {
            ...payload.execution,
            configRevision: {
              ...payload.execution.configRevision,
              runId: DRIVER_TEST_IDS.secondRunId,
            },
            session: {
              ...payload.execution.session,
              nativeCheckpoint: checkpoint,
              nativeResumeRef: {
                runtimeId: "pi",
                kind: "pi_session_path",
                value: pointer.resumePointer,
              },
            },
          },
        },
        env: { MOSOO_PI_EXECUTABLE: "node", MOSOO_PI_ARGS: JSON.stringify([cli]) },
        expectedCapabilities: expectedDriverCapabilities("pi"),
        organizationPath: root,
        rootPath: root,
        forbiddenSecrets: ["artifact-pi-grant"],
        startTimeoutMs: 20_000,
      });
      const resumed = await controller.runTurn({
        commandId: "pi-resumed-input",
        requestId: "pi-resumed-request",
        runId: DRIVER_TEST_IDS.secondRunId,
        text: "Continue the restored conversation.",
        timeoutMs: 20_000,
      });
      const resumedCompletion = resumed.find((event) => event.kind === "run.completed")
        ?.payload as {
        finalMessageId: string;
        checkpoint: unknown;
      };
      expect(resumedCompletion).not.toHaveProperty("finalMessageText");
      expect(
        messageText(
          resumed.filter((event) => event.kind === "message.added"),
          resumedCompletion.finalMessageId,
        ),
      ).toBe("Pi artifact succeeded.");
      parseNativeCheckpoint(resumedCompletion.checkpoint);
      expect(
        resumed.find((event) => event.kind === "runtime.resume.updated")?.payload,
      ).toMatchObject({ resumePointer: pointer.resumePointer });
      await controller.stopDriver("pi-resumed-stop", 15_000);
    } finally {
      await controller?.dispose();
      await model.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);
