import { afterEach, expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBashTool, createPowerShellTool } from "@earendil-works/pi-coding-agent";

import {
  MAX_NATIVE_CHECKPOINT_ENTRIES,
  MAX_NATIVE_CHECKPOINT_FILE_BYTES,
  MAX_PI_NATIVE_CHECKPOINT_BYTES,
  parseNativeCheckpointManifest,
} from "../src/protocol/native-checkpoint";
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
  const outputs = join(home, "outputs");
  const temporary = join(home, "tmp");
  await Promise.all([outputs, temporary].map((path) => mkdir(path, { recursive: true })));
  const root = await pinNativeCheckpointRoot(cwd);
  const content = (
    fullOutputPath: unknown = join(outputs, bash),
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
    outputs,
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
  const binaryReference = `[Binary resource resource://example/data.bin (application/octet-stream, 5 B) saved to ${join(run.outputs, binary)}]`;
  await Promise.all([
    writeFile(join(run.outputs, bash), "bash output"),
    writeFile(join(run.outputs, powershell), "powershell output"),
    writeFile(join(run.outputs, mcpText), `MCP content\n${binaryReference}\n`),
    writeFile(join(run.outputs, binary), binaryBytes),
    writeFile(join(run.outputs, "secret.json"), "do not save"),
    writeFile(join(run.home, "models.json"), "private configuration"),
    symlink(join(run.home, "models.json"), join(run.outputs, "unrelated-link")),
  ]);
  const content = run.content(join(run.outputs, mcpText));
  const checkpoint = await run.create(content);
  const saved = await readNativeCheckpoint({ cwd: run.cwd, checkpoint });
  expect(saved.manifest.files.map((file) => file.path).toSorted()).toEqual(
    [
      "native-home.json",
      "session.jsonl",
      ...[bash, powershell, mcpText, binary].map((name) => `outputs/${name}`),
    ].toSorted(),
  );
  await rm(run.home, { recursive: true });
  await restorePiNativeOutputs({ saved, content, home: run.home, signal });
  expect(await readFile(join(run.outputs, binary))).toEqual(binaryBytes);
  expect(await readFile(join(run.outputs, bash), "utf8")).toBe("bash output");
  expect(await readFile(join(run.outputs, powershell), "utf8")).toBe("powershell output");
  await rejects(readFile(join(run.outputs, "secret.json")));
});

test.each(["missing", "symbolic link", "hard link", "directory", "oversized"])(
  "checkpoint rejects %s native outputs before publishing the snapshot",
  async (damage) => {
    const run = await fixture();
    const path = join(run.outputs, bash);
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
  await writeFile(join(run.outputs, bash), "output");
  const path =
    damage === "outside home"
      ? join(run.cwd, bash)
      : damage === "parent traversal"
        ? `${run.outputs}/../outputs/${bash}`
        : damage === "legacy temporary path"
          ? `/tmp/${bash}`
          : damage === "unsupported name"
            ? join(run.outputs, "secret.json")
            : null;
  await rejects(run.create(run.content(path)), /outside/u);
});

test("checkpoint rejects cumulative output size before copying and preserves the previous bundle", async () => {
  const run = await fixture();
  await writeFile(join(run.outputs, bash), "committed output");
  const checkpoint = await run.create();
  for (const name of [powershell, binary]) {
    await writeFile(join(run.outputs, name), "");
    await truncate(join(run.outputs, name), MAX_NATIVE_CHECKPOINT_FILE_BYTES);
  }
  await rejects(
    createPiNativeCheckpoint({
      root: run.root,
      home: run.home,
      content: run.content(),
      runId: DRIVER_TEST_IDS.secondRunId,
      nativeRef,
      signal,
    }),
    /total size limit/u,
  );
  expect((await readdir(join(run.cwd, ".state/native-checkpoints"))).toSorted()).toEqual([
    ".gitignore",
    DRIVER_TEST_IDS.runId,
  ]);
  const saved = await readNativeCheckpoint({ cwd: run.cwd, checkpoint });
  expect((await saved.readFile(`outputs/${bash}`)).toString()).toBe("committed output");
  expect((await stat(join(run.outputs, powershell))).size).toBe(MAX_NATIVE_CHECKPOINT_FILE_BYTES);
});

test("recovery rejects a manifest over the Pi payload budget before reading its files", async () => {
  const run = await fixture();
  await writeFile(join(run.outputs, bash), "committed output");
  const checkpoint = await run.create();
  const saved = await readNativeCheckpoint({ cwd: run.cwd, checkpoint });
  const files = saved.manifest.files.map((file, index) => ({
    ...file,
    size: index < 2 ? MAX_NATIVE_CHECKPOINT_FILE_BYTES : 0,
  }));
  const manifest = { ...saved.manifest, files };
  expect(files.reduce((bytes, file) => bytes + file.size, 0)).toBe(MAX_PI_NATIVE_CHECKPOINT_BYTES);
  expect(parseNativeCheckpointManifest(manifest)).toEqual(manifest);
  files[2]!.size = 1;
  await writeFile(join(saved.directory, "manifest.json"), JSON.stringify(manifest));
  await rejects(readNativeCheckpoint({ cwd: run.cwd, checkpoint }), /total size limit/u);
  expect(await readFile(join(run.outputs, bash), "utf8")).toBe("committed output");
});

test("checkpoint preserves native outputs without treating quoted paths as metadata", async () => {
  const run = await fixture();
  const quotedBinary = `[Binary resource resource://data (application/octet-stream, 5 B) saved to /tmp/${binary}]`;
  const quotedShell = `[Showing lines 3001-5000 of 5000. Full output: /tmp/${bash}]`;
  await writeFile(join(run.outputs, mcpText), quotedBinary);
  const content = run.content(join(run.outputs, mcpText), `${quotedBinary}\n${quotedShell}`);
  const saved = await readNativeCheckpoint({ cwd: run.cwd, checkpoint: await run.create(content) });
  await rm(run.home, { recursive: true });
  await restorePiNativeOutputs({ saved, content, home: run.home, signal });
  expect(await readFile(join(run.outputs, mcpText), "utf8")).toBe(quotedBinary);
});

test("shell temporary files do not consume the native output checkpoint entry limit", async () => {
  const run = await fixture();
  const files = Array.from({ length: MAX_NATIVE_CHECKPOINT_ENTRIES + 1 }, (_, index) =>
    join(run.temporary, `build-cache-${index}`),
  );
  for (let offset = 0; offset < files.length; offset += 100) {
    await Promise.all(files.slice(offset, offset + 100).map((path) => writeFile(path, "")));
  }
  await writeFile(join(run.outputs, bash), "native output");
  const content = run.content();
  const saved = await readNativeCheckpoint({ cwd: run.cwd, checkpoint: await run.create(content) });
  await restorePiNativeOutputs({ saved, content, home: run.home, signal });
  expect(saved.manifest.files.map((file) => file.path).toSorted()).toEqual([
    "native-home.json",
    `outputs/${bash}`,
    "session.jsonl",
  ]);
  expect(await readFile(files.at(-1)!, "utf8")).toBe("");
});

test("restore requires the original native home and rejects unexpected checkpoint files", async () => {
  const run = await fixture();
  await writeFile(join(run.outputs, bash), "output");
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
    const path = join(run.outputs, bash);
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
  await writeFile(join(run.outputs, bash), "original");
  const saved = await readNativeCheckpoint({ cwd: run.cwd, checkpoint: await run.create() });
  await writeFile(join(run.outputs, powershell), "uncommitted output");
  await writeFile(join(saved.directory, "outputs", bash), "tampered");
  await rejects(
    restorePiNativeOutputs({ saved, content: run.content(), home: run.home, signal }),
    /manifest/u,
  );
  expect(await readFile(join(run.outputs, bash), "utf8")).toBe("original");
  expect(await readFile(join(run.outputs, powershell), "utf8")).toBe("uncommitted output");
});

test("restore removes stale native outputs after validation and preserves unrelated temporary files", async () => {
  const run = await fixture();
  await writeFile(join(run.outputs, bash), "committed output");
  const saved = await readNativeCheckpoint({ cwd: run.cwd, checkpoint: await run.create() });
  await writeFile(join(run.outputs, powershell), "uncommitted output");
  await writeFile(join(run.outputs, "user-temp.txt"), "unrelated temporary file");
  await restorePiNativeOutputs({ saved, content: run.content(), home: run.home, signal });
  expect(await readFile(join(run.outputs, bash), "utf8")).toBe("committed output");
  await rejects(readFile(join(run.outputs, powershell)));
  expect(await readFile(join(run.outputs, "user-temp.txt"), "utf8")).toBe(
    "unrelated temporary file",
  );
});

test.each([
  { toolName: "bash", output: "output line\n".repeat(5_000), error: "timeout:1" },
  { toolName: "powershell", output: `${"x".repeat(200)}\n`.repeat(1_000), error: "aborted" },
  { toolName: "bash", output: "x".repeat(80_000), error: null },
])(
  "checkpoint restores native $toolName error output when details were dropped",
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
      process.env["TMPDIR"] = run.outputs;
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
    const saved = await readNativeCheckpoint({
      cwd: run.cwd,
      checkpoint: await run.create(content),
    });
    await rm(run.home, { recursive: true });
    await restorePiNativeOutputs({ saved, content, home: run.home, signal });
    expect(await readFile(outputPath!)).toEqual(bytes);
  },
);

test("quoted native output footers do not require files outside the Session output directory", async () => {
  const run = await fixture();
  const text = `[Showing lines 3001-5000 of 5000. Full output: /tmp/${bash}]\n[Binary resource resource://data (application/octet-stream, 5 B) saved to /tmp/${binary}]`;
  await run.create(run.content(undefined, text, { details: {} }));
});
