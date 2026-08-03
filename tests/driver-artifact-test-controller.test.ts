import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ForbiddenSecretScanner,
  DriverArtifactTestController,
  type DriverArtifactBootPayload,
} from "./driver-artifact-test-controller";
import {
  parseDriverCommandUpdateInput,
  parseDriverFailureInput,
  parseDriverHelloInput,
  parseDriverLogBatchInput,
} from "../src/protocol/orpc";

const FORBIDDEN_SECRET_ERROR = "Forbidden secret detected in packed driver traffic or output.";
const FAKE_DRIVER = String.raw`
const payload = await Bun.file(process.env.MOSOO_DRIVER_BOOT_PAYLOAD_FILE).json();
const url = new URL(payload.controlUrl);
url.searchParams.set("driverInstanceId", payload.driverInstanceId);
url.searchParams.set("token", payload.bootToken);
const socket = new WebSocket(url);
const pending = new Map();
let nextId = 0;
socket.addEventListener("message", ({ data }) => {
  const response = JSON.parse(String(data));
  pending.get(response.i)?.(response.p.b.json);
  pending.delete(response.i);
});
const rpc = (path, input) => new Promise((resolve) => {
  const id = ++nextId;
  pending.set(id, resolve);
  socket.send(JSON.stringify({ i: id, p: { b: { json: input }, u: path } }));
});
await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
await rpc("/driver/hello", {
  capabilities: [],
  driverVersion: "test",
  pid: process.pid,
  protocolVersion: 2,
  runtime: payload.runtime,
  startedAt: new Date().toISOString(),
});
if (process.env.TEST_MODE === "log") {
  await rpc("/driver/pushLogs", {
    driverInstanceId: payload.driverInstanceId,
    logs: [{
      error: {
        code: "EPIPE",
        message: process.env.TEST_LOG_MESSAGE ?? "transport exploded",
        name: "Error",
      },
      fields: { stage: "session/new" },
      level: "error",
      message: "driver.acp.transport.failed",
      seq: 0,
      timestamp: new Date().toISOString(),
    }],
  });
}
await rpc("/driver/ready", {
  at: process.env.TEST_MODE === "raw" ? process.env.TEST_SECRET : new Date().toISOString(),
  driverInstanceId: payload.driverInstanceId,
  pid: process.pid,
});
if (process.env.TEST_MODE === "terminal") {
  await rpc("/driver/commandUpdate", {
    commandId: "command-1",
    driverInstanceId: payload.driverInstanceId,
    result: null,
    status: "completed",
  });
}
await Bun.sleep(100);
process.stdout.write(process.env.TEST_SECRET.slice(0, 9));
await Bun.sleep(100);
process.stdout.write(process.env.TEST_SECRET.slice(9));
await Bun.sleep(100);
socket.close();
`;

let temporaryRoot: string | null = null;

async function captureError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected the operation to fail.");
}

afterEach(async () => {
  if (temporaryRoot !== null) {
    await rm(temporaryRoot, { force: true, recursive: true });
    temporaryRoot = null;
  }
});

describe("driver artifact test controller", () => {
  test("returns an accepted terminal after the driver exits", async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "driver-controller-test-"));
    const organizationPath = join(temporaryRoot, "workspace");
    const artifactPath = join(temporaryRoot, "fake-driver.ts");
    await mkdir(organizationPath);
    await writeFile(artifactPath, FAKE_DRIVER);
    const controller = await DriverArtifactTestController.start({
      artifactPath,
      bootPayload: {
        bootToken: "boot-token",
        driverInstanceId: "driver-test",
        execution: { configRevision: { sessionId: "session-test" } },
        runtime: "acp-fallback",
      },
      env: { TEST_MODE: "terminal", TEST_SECRET: "unused" },
      organizationPath,
      rootPath: temporaryRoot,
      startTimeoutMs: 2_000,
    });

    await controller.waitForExit(2_000);
    await expect(controller.waitForCommandTerminal("command-1", 100)).resolves.toMatchObject({
      status: "completed",
    });
    await controller.dispose();
  });

  test("includes structured log failures in diagnostics", async () => {
    const secret = 'credential"\\\nvalue';
    temporaryRoot = await mkdtemp(join(tmpdir(), "driver-controller-test-"));
    const organizationPath = join(temporaryRoot, "workspace");
    const artifactPath = join(temporaryRoot, "fake-driver.ts");
    await mkdir(organizationPath);
    await writeFile(artifactPath, FAKE_DRIVER);
    const controller = await DriverArtifactTestController.start({
      artifactPath,
      bootPayload: {
        bootToken: "boot-token",
        driverInstanceId: "driver-test",
        execution: { configRevision: { sessionId: "session-test" } },
        runtime: "acp-fallback",
      },
      env: {
        TEST_LOG_MESSAGE: `transport exploded: ${secret}`,
        TEST_MODE: "log",
        TEST_SECRET: "unused",
      },
      forbiddenSecrets: [secret],
      organizationPath,
      rootPath: temporaryRoot,
      startTimeoutMs: 2_000,
    });

    const diagnostics = controller.diagnostics();
    expect(diagnostics).toContain('"message": "transport exploded: [redacted]"');
    expect(diagnostics).toContain('"stage": "session/new"');
    expect(diagnostics).not.toContain(secret);
    expect(diagnostics).not.toContain(JSON.stringify(secret).slice(1, -1));
    await controller.dispose();
  });

  test("rejects unexpected hello capabilities", async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "driver-controller-test-"));
    const organizationPath = join(temporaryRoot, "workspace");
    const artifactPath = join(temporaryRoot, "fake-driver.ts");
    await mkdir(organizationPath);
    await writeFile(artifactPath, FAKE_DRIVER);

    const startError = await captureError(
      DriverArtifactTestController.start({
        artifactPath,
        bootPayload: {
          bootToken: "boot-token",
          driverInstanceId: "driver-test",
          execution: { configRevision: { sessionId: "session-test" } },
          runtime: "acp-fallback",
        },
        env: { TEST_SECRET: "unused" },
        expectedCapabilities: [{ id: "input_start", status: "supported", version: 1 }],
        organizationPath,
        rootPath: temporaryRoot,
        startTimeoutMs: 2_000,
      }),
    );

    expect(startError.message).toContain(
      "Driver hello capabilities did not match the expected runtime contract.",
    );
  });

  test("rejects a forbidden secret in a raw RPC frame without echoing it", async () => {
    const secret = "raw-frame-credential";
    temporaryRoot = await mkdtemp(join(tmpdir(), "driver-controller-test-"));
    const organizationPath = join(temporaryRoot, "workspace");
    const artifactPath = join(temporaryRoot, "fake-driver.ts");
    await mkdir(organizationPath);
    await writeFile(artifactPath, FAKE_DRIVER);
    const startError = await captureError(
      DriverArtifactTestController.start({
        artifactPath,
        bootPayload: {
          bootToken: "boot-token",
          driverInstanceId: "driver-test",
          execution: { configRevision: { sessionId: "session-test" } },
          runtime: "acp-fallback",
        },
        env: { TEST_MODE: "raw", TEST_SECRET: secret },
        forbiddenSecrets: [secret],
        organizationPath,
        rootPath: temporaryRoot,
        startTimeoutMs: 2_000,
      }),
    );

    expect(startError.message).toContain(FORBIDDEN_SECRET_ERROR);
    expect(startError.message).not.toContain(secret);
  });

  test("detects a forbidden secret split across output chunks and fails terminal waits", async () => {
    const secret = "sentinel-credential";
    temporaryRoot = await mkdtemp(join(tmpdir(), "driver-controller-test-"));
    const organizationPath = join(temporaryRoot, "workspace");
    const artifactPath = join(temporaryRoot, "fake-driver.ts");
    await mkdir(organizationPath);
    await writeFile(artifactPath, FAKE_DRIVER);
    const bootPayload = {
      bootToken: "boot-token",
      driverInstanceId: "driver-test",
      execution: { configRevision: { sessionId: "session-test" } },
      runtime: "acp-fallback",
    } satisfies DriverArtifactBootPayload;
    const controller = await DriverArtifactTestController.start({
      artifactPath,
      bootPayload,
      env: { TEST_SECRET: secret },
      forbiddenSecrets: [secret],
      organizationPath,
      rootPath: temporaryRoot,
      startTimeoutMs: 2_000,
    });

    const exitError = await captureError(controller.waitForExit(2_000));
    expect(exitError.message).toContain(FORBIDDEN_SECRET_ERROR);
    expect(exitError.message).not.toContain(secret);
    expect(controller.diagnostics()).toContain('"forbiddenSecretDetected": true');
    expect(controller.diagnostics()).not.toContain(secret);
    const disposeError = await captureError(controller.dispose());
    expect(disposeError.message).toContain(FORBIDDEN_SECRET_ERROR);
    expect(disposeError.message).not.toContain(secret);
  });

  test("validates structured RPC inputs with the production parsers", () => {
    expect(() =>
      parseDriverHelloInput({
        capabilities: [],
        driverVersion: "test",
        pid: 0,
        protocolVersion: 2,
        runtime: "acp-fallback",
        startedAt: "now",
      }),
    ).toThrow("pid must be a positive safe integer");
    expect(() =>
      parseDriverCommandUpdateInput({
        commandId: "command-1",
        driverInstanceId: "driver-1",
        status: "invented",
      }),
    ).toThrow("status is not a supported runtime command status");
    expect(
      parseDriverCommandUpdateInput({
        commandId: "command-1",
        driverInstanceId: "driver-1",
        result: {
          isError: true,
          outputText: "failed",
          requestId: "request-1",
          serverId: "server-1",
          toolName: "tool-1",
        },
        status: "completed",
      }).result,
    ).toMatchObject({ isError: true });
    expect(() =>
      parseDriverFailureInput({
        driverInstanceId: "driver-1",
        error: {
          code: "failed",
          details: { nested: {} },
          message: "failed",
          retryable: false,
        },
      }),
    ).toThrow("driver failure details.nested must be a primitive value");
    expect(() =>
      parseDriverLogBatchInput({
        driverInstanceId: "driver-1",
        logs: [{ level: "verbose", message: "bad", seq: 0, timestamp: "now" }],
      }),
    ).toThrow("driver log level is unsupported");
  });

  test("scanner carries only the suffix needed for cross-chunk detection", () => {
    const scanner = new ForbiddenSecretScanner(["sentinel-credential"]);
    expect(scanner.scan("noise-sentinel-")).toBe(false);
    expect(scanner.scan("credential-noise")).toBe(true);
  });
});
