import { afterEach, expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBashTool, createPowerShellTool } from "@earendil-works/pi-coding-agent";

import { MAX_NATIVE_CHECKPOINT_FILE_BYTES } from "../src/protocol/native-checkpoint";
import type { DriverNativeRuntimeRef } from "../src/protocol/runtime";
import {
  createNativeCheckpoint,
  pinNativeCheckpointRoot,
  readNativeCheckpoint,
} from "../src/runtimes/native-checkpoint";
import { createPiNativeCheckpoint, restorePiNativeOutputs } from "../src/runtimes/pi/pi-checkpoint";
import { DRIVER_TEST_IDS } from "./driver-boot-payload-fixture";

const roots: string[] = [];
const signal = AbortSignal.any([]);
const bash = "pi-bash-0123456789abcdef.log";
const powershell = "pi-powershell-0123456789abcdef.log";
const mcpText = "pi-mcp-0123456789abcdef.txt";
const binary = "pi-mcp-fedcba9876543210.bin";
const nativeRef: DriverNativeRuntimeRef = {
  runtimeId: "pi",
  kind: "pi_session_path",
  value: "sessions/test.jsonl",
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "mosoo-pi-checkpoint-"));
  roots.push(cwd);
  const home = join(cwd, "pi");
  const temporary = join(home, "tmp");
  await mkdir(temporary, { recursive: true });
  const root = await pinNativeCheckpointRoot(cwd);
  const content = (
    fullOutputPath: unknown = join(temporary, bash),
    text = "truncated",
    message: object = {},
  ) =>
    [
      { type: "session", version: 3, id: "session", timestamp: "now", cwd },
      {
        type: "message",
        id: "tool-result",
        parentId: null,
        timestamp: "now",
        message: {
          role: "toolResult",
          toolCallId: "tool",
          toolName: "bash",
          content: [{ type: "text", text }],
          details: { fullOutputPath },
          ...message,
        },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n") + "\n";
  return {
    cwd,
    home,
    temporary,
    root,
    content,
    create: (session = content()) =>
      createPiNativeCheckpoint({
        root,
        home,
        content: session,
        runId: DRIVER_TEST_IDS.runId,
        nativeRef,
        signal,
      }),
  };
}

test("native output checkpoint cold restores shell logs and binary MCP files without arbitrary temporary data", async () => {
  const run = await fixture();
  const binaryBytes = Buffer.from([0x00, 0xff, 0xc3, 0x28, 0x80]);
  const binaryReference = `[Binary resource resource://example/data.bin (application/octet-stream, 5 B) saved to ${join(run.temporary, binary)}]`;
  await Promise.all([
    writeFile(join(run.temporary, bash), "bash output"),
    writeFile(join(run.temporary, powershell), "powershell output"),
    writeFile(join(run.temporary, mcpText), `MCP content\n${binaryReference}\n`),
    writeFile(join(run.temporary, binary), binaryBytes),
    writeFile(join(run.temporary, "secret.json"), "do not save"),
    writeFile(join(run.home, "models.json"), "private configuration"),
    symlink(join(run.home, "models.json"), join(run.temporary, "unrelated-link")),
  ]);
  const content = run.content(join(run.temporary, mcpText));
  const checkpoint = await run.create(content);
  const saved = await readNativeCheckpoint({ cwd: run.cwd, checkpoint });
  expect(saved.manifest.files.map((file) => file.path).toSorted()).toEqual(
    [
      "native-home.json",
      "session.jsonl",
      ...[bash, powershell, mcpText, binary].map((name) => `tmp/${name}`),
    ].toSorted(),
  );
  await rm(run.home, { recursive: true });
  await restorePiNativeOutputs({ saved, content, home: run.home, signal });
  expect(await readFile(join(run.temporary, binary))).toEqual(binaryBytes);
  expect(await readFile(join(run.temporary, bash), "utf8")).toBe("bash output");
  expect(await readFile(join(run.temporary, powershell), "utf8")).toBe("powershell output");
  await rejects(readFile(join(run.temporary, "secret.json")));
});

test.each(["missing", "symbolic link", "hard link", "directory", "oversized"])(
  "checkpoint rejects %s native outputs before publishing the snapshot",
  async (damage) => {
    const run = await fixture();
    const path = join(run.temporary, bash);
    const target = join(run.cwd, "outside");
    await writeFile(target, "original");
    if (damage === "symbolic link") await symlink(target, path);
    if (damage === "hard link") await link(target, path);
    if (damage === "directory") await mkdir(path);
    if (damage === "oversized") {
      await writeFile(path, "");
      await truncate(path, MAX_NATIVE_CHECKPOINT_FILE_BYTES + 1);
    }
    await rejects(run.create());
    await rejects(
      readFile(join(run.cwd, ".state/native-checkpoints", DRIVER_TEST_IDS.runId, "manifest.json")),
    );
    expect(await readFile(target, "utf8")).toBe("original");
  },
);

test.each([
  "outside home",
  "parent traversal",
  "legacy temporary path",
  "unsupported name",
  "non-string",
])("checkpoint rejects %s output references", async (damage) => {
  const run = await fixture();
  await writeFile(join(run.temporary, bash), "output");
  const path =
    damage === "outside home"
      ? join(run.cwd, bash)
      : damage === "parent traversal"
        ? `${run.temporary}/../tmp/${bash}`
        : damage === "legacy temporary path"
          ? `/tmp/${bash}`
          : damage === "unsupported name"
            ? join(run.temporary, "secret.json")
            : null;
  await rejects(run.create(run.content(path)), /outside/u);
});

test("checkpoint rejects missing MCP binary output referenced inside its truncated text file", async () => {
  const run = await fixture();
  await writeFile(
    join(run.temporary, mcpText),
    `[Binary resource resource://data (application/octet-stream, 5 B) saved to ${join(run.temporary, binary)}]`,
  );
  await rejects(
    run.create(run.content(join(run.temporary, mcpText))),
    /missing a referenced output/u,
  );
});

test("restore requires the original native home and rejects unexpected checkpoint files", async () => {
  const run = await fixture();
  await writeFile(join(run.temporary, bash), "output");
  const saved = await readNativeCheckpoint({ cwd: run.cwd, checkpoint: await run.create() });
  await rejects(
    restorePiNativeOutputs({ saved, content: run.content(), home: join(run.cwd, "moved"), signal }),
    /original native home/u,
  );
  const checkpoint = await createNativeCheckpoint({
    root: run.root,
    runId: DRIVER_TEST_IDS.secondRunId,
    nativeRef,
    signal,
    write: async (directory) => {
      await writeFile(join(directory, "session.jsonl"), run.content());
      await writeFile(join(directory, "models.json"), "private model configuration");
    },
  });
  await rejects(
    restorePiNativeOutputs({
      saved: await readNativeCheckpoint({ cwd: run.cwd, checkpoint }),
      content: run.content(),
      home: run.home,
      signal,
    }),
    /unsupported file/u,
  );
});

test.each(["symbolic link", "hard link"])(
  "restore refuses a %s output destination",
  async (damage) => {
    const run = await fixture();
    const path = join(run.temporary, bash);
    await writeFile(path, "output");
    const saved = await readNativeCheckpoint({ cwd: run.cwd, checkpoint: await run.create() });
    await rm(path);
    const target = join(run.cwd, "outside");
    await writeFile(target, "untouched");
    if (damage === "symbolic link") await symlink(target, path);
    else await link(target, path);
    await rejects(
      restorePiNativeOutputs({ saved, content: run.content(), home: run.home, signal }),
      /without links/u,
    );
    expect(await readFile(target, "utf8")).toBe("untouched");
  },
);

test("restore verifies output hashes again after opening the saved checkpoint", async () => {
  const run = await fixture();
  await writeFile(join(run.temporary, bash), "original");
  const saved = await readNativeCheckpoint({ cwd: run.cwd, checkpoint: await run.create() });
  await writeFile(join(run.temporary, powershell), "uncommitted output");
  await writeFile(join(saved.directory, "tmp", bash), "tampered");
  await rejects(
    restorePiNativeOutputs({ saved, content: run.content(), home: run.home, signal }),
    /manifest/u,
  );
  expect(await readFile(join(run.temporary, bash), "utf8")).toBe("original");
  expect(await readFile(join(run.temporary, powershell), "utf8")).toBe("uncommitted output");
});

test("restore removes stale native outputs after validation and preserves unrelated temporary files", async () => {
  const run = await fixture();
  await writeFile(join(run.temporary, bash), "committed output");
  const saved = await readNativeCheckpoint({ cwd: run.cwd, checkpoint: await run.create() });
  await writeFile(join(run.temporary, powershell), "uncommitted output");
  await writeFile(join(run.temporary, "user-temp.txt"), "unrelated temporary file");
  await restorePiNativeOutputs({ saved, content: run.content(), home: run.home, signal });
  expect(await readFile(join(run.temporary, bash), "utf8")).toBe("committed output");
  await rejects(readFile(join(run.temporary, powershell)));
  expect(await readFile(join(run.temporary, "user-temp.txt"), "utf8")).toBe(
    "unrelated temporary file",
  );
});

test.each([
  { toolName: "bash", output: "output line\n".repeat(5_000), error: "timeout:1" },
  { toolName: "powershell", output: `${"x".repeat(200)}\n`.repeat(1_000), error: "aborted" },
  { toolName: "bash", output: "x".repeat(80_000), error: null },
])(
  "checkpoint validates native $toolName error output references when details were dropped",
  async ({ toolName, output, error }) => {
    const run = await fixture();
    const createTool = toolName === "bash" ? createBashTool : createPowerShellTool;
    const tool = createTool(run.cwd, {
      exposeSessionEnvironment: false,
      operations: {
        exec: async (_command, _cwd, options) => {
          options.onData(Buffer.from(output));
          if (error !== null) throw new Error(error);
          return { exitCode: null };
        },
      },
    });
    const previousTemporary = process.env["TMPDIR"];
    let errorText = "";
    try {
      process.env["TMPDIR"] = run.temporary;
      await rejects(
        tool.execute("error-output", { command: "unused", timeout: 1 }),
        (failure: unknown) => {
          if (!(failure instanceof Error)) throw failure;
          errorText = failure.message;
          return true;
        },
      );
    } finally {
      if (previousTemporary === undefined) delete process.env["TMPDIR"];
      else process.env["TMPDIR"] = previousTemporary;
    }
    expect(errorText).toContain(
      error === "timeout:1"
        ? "Command timed out after 1 seconds"
        : error === "aborted"
          ? "Command aborted"
          : "Command terminated without an exit code",
    );
    const outputPath = /^\[Showing .+ Full output: (.+)\]$/mu.exec(errorText)?.[1];
    expect(outputPath).toBeDefined();
    const bytes = await readFile(outputPath!);
    expect(bytes.toString("utf8")).toBe(output);
    const content = run.content(undefined, errorText, { toolName, details: {}, isError: true });
    await rm(outputPath!);
    await rejects(run.create(content), /missing a referenced output/u);
    await rejects(
      readFile(join(run.cwd, ".state/native-checkpoints", DRIVER_TEST_IDS.runId, "manifest.json")),
    );
    await writeFile(outputPath!, bytes);
    const saved = await readNativeCheckpoint({
      cwd: run.cwd,
      checkpoint: await run.create(content),
    });
    await rm(run.home, { recursive: true });
    await restorePiNativeOutputs({ saved, content, home: run.home, signal });
    expect(await readFile(outputPath!)).toEqual(bytes);
  },
);

test("shell error output footers reject references outside the Session output directory", async () => {
  const run = await fixture();
  const text = `[Showing lines 3001-5000 of 5000. Full output: /tmp/${bash}]\n\nCommand timed out after 1 seconds`;
  await rejects(
    run.create(run.content(undefined, text, { details: {}, isError: true })),
    /outside/u,
  );
  await run.create(run.content(undefined, text, { toolName: "read", details: {} }));
});
