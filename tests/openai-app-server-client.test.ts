import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBufferedSinkLogger } from "../src/observability";
import { createDriverStartInputFromBootPayload } from "../src/protocol/start";
import { createAgentDriverContext } from "../src/runtimes/agent-driver-backend";
import { OpenAiAppServerClient } from "../src/runtimes/openai/app-server-client";
import { driverBootPayload } from "./driver-boot-payload-fixture";

const originalExecutable = process.env["MOSOO_OPENAI_RUNTIME_EXECUTABLE"];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  if (originalExecutable === undefined) {
    delete process.env["MOSOO_OPENAI_RUNTIME_EXECUTABLE"];
  } else {
    process.env["MOSOO_OPENAI_RUNTIME_EXECUTABLE"] = originalExecutable;
  }

  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("OpenAi app-server client", () => {
  test("reports process exit after queued server messages", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mosoo-openai-client-"));
    temporaryDirectories.push(directory);
    const executable = join(directory, "fake-app-server");
    await Bun.write(
      executable,
      `#!/usr/bin/env bun
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const newline = buffer.indexOf("\\n");
  if (newline < 0) return;
  const request = JSON.parse(buffer.slice(0, newline));
  process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\\n");
  setTimeout(() => process.exit(17), 25);
});
`,
    );
    await chmod(executable, 0o755);
    process.env["MOSOO_OPENAI_RUNTIME_EXECUTABLE"] = executable;

    const payload = createDriverStartInputFromBootPayload({
      ...driverBootPayload,
      execution: {
        ...driverBootPayload.execution,
        session: {
          ...driverBootPayload.execution.session,
          context: {
            ...driverBootPayload.execution.session.context,
            homePath: join(directory, "home"),
            sessionOrganizationPath: directory,
          },
          cwd: directory,
        },
      },
    });
    const logger = createBufferedSinkLogger({
      level: "debug",
      service: "openai-app-server-client-test",
      sink: async () => {},
    });
    const context = createAgentDriverContext({
      eventSink: { pushEvents: async () => {} },
      logger,
      payload,
      permission: { request: async () => "allow_once" },
    });
    const protocolErrors: Error[] = [];
    const client = new OpenAiAppServerClient(payload, {
      ...context,
      handleNotification: async () => {},
      handleProtocolError: async (error) => {
        protocolErrors.push(error);
      },
    });

    await client.start();

    for (let attempt = 0; attempt < 50 && protocolErrors.length === 0; attempt += 1) {
      await Bun.sleep(10);
    }

    expect(protocolErrors).toHaveLength(1);
    expect(protocolErrors[0]?.message).toBe("OpenAi app-server exited with code 17.");
    client.stop();
    await logger.destroy();
  });
});
