import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import type { AgentDriverContext } from "../../core/agent-driver-backend";
import { isRecord, readNonEmptyString, readNumber } from "./acp-types";
import { AcpPathScope } from "./acp-path-scope";

interface AcpFileSystemOptions {
  readonly allowedRoots: readonly string[];
  readonly cwd: string;
  readonly pathScope?: AcpPathScope | undefined;
}

const MAX_ACP_FILE_BYTES = 8 * 1_024 * 1_024;
const FILE_CHUNK_BYTES = 64 * 1_024;

export class AcpFileSystem {
  readonly #pathScope: AcpPathScope;

  constructor(options: AcpFileSystemOptions) {
    this.#pathScope = options.pathScope ?? new AcpPathScope(options);
  }

  async readTextFile(params: unknown, signal?: AbortSignal): Promise<{ content: string }> {
    signal?.throwIfAborted();
    const record = isRecord(params) ? params : {};
    const requestedPath = readNonEmptyString(record, "path");

    if (requestedPath === null) {
      throw new Error("ACP fs/read_text_file requires a path.");
    }

    const path = await this.#pathScope.openFile(requestedPath, "ACP file path");
    let raw: string;

    try {
      const metadata = await path.file.stat();
      signal?.throwIfAborted();

      if (!metadata.isFile()) {
        throw new Error("ACP fs/read_text_file requires a regular file.");
      }

      if (metadata.size > MAX_ACP_FILE_BYTES) {
        throw new Error(`ACP file exceeds ${MAX_ACP_FILE_BYTES} bytes.`);
      }

      raw = await readBoundedText(path.file, signal);
    } finally {
      await path.file.close();
    }
    const line = readNumber(record, "line");
    const limit = readNumber(record, "limit");

    if (line === null && limit === null) {
      return { content: raw };
    }

    const lines = raw.split("\n");
    const startIndex = line === null ? 0 : Math.max(0, Math.floor(line) - 1);
    const endIndex = limit === null ? undefined : startIndex + Math.max(0, Math.floor(limit));

    return {
      content: lines.slice(startIndex, endIndex).join("\n"),
    };
  }

  async writeTextFile(
    context: AgentDriverContext,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<Record<string, never>> {
    signal?.throwIfAborted();
    const record = isRecord(params) ? params : {};
    const requestedPath = readNonEmptyString(record, "path");
    const content = typeof record["content"] === "string" ? record["content"] : null;

    if (requestedPath === null || content === null) {
      throw new Error("ACP fs/write_text_file requires path and content.");
    }

    if (Buffer.byteLength(content, "utf8") > MAX_ACP_FILE_BYTES) {
      throw new Error(`ACP file exceeds ${MAX_ACP_FILE_BYTES} bytes.`);
    }

    const path = await this.#pathScope.openWritable(requestedPath, "ACP file path");
    const temporaryPath = join(path.directory.procPath, `.${randomUUID()}.tmp`);
    const destinationPath = join(path.directory.procPath, path.name);
    let temporaryCreated = false;
    let committed = false;

    try {
      const mode = await readExistingMode(destinationPath);
      const temporary = await open(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      temporaryCreated = true;

      try {
        const bytes = Buffer.from(content, "utf8");
        let offset = 0;

        while (offset < bytes.length) {
          signal?.throwIfAborted();
          const { bytesWritten } = await temporary.write(
            bytes,
            offset,
            Math.min(FILE_CHUNK_BYTES, bytes.length - offset),
            offset,
          );

          if (bytesWritten === 0) {
            throw new Error("ACP fs/write_text_file could not make write progress.");
          }
          offset += bytesWritten;
        }

        await temporary.chmod(mode);
        signal?.throwIfAborted();
        await temporary.sync();
        signal?.throwIfAborted();
        await rename(temporaryPath, destinationPath);
        committed = true;
        await path.directory.file.sync();
      } finally {
        await temporary.close();
      }

      const changedPath = join(await this.#pathScope.identify(path.directory), path.name);
      await context.ports.file.reportChanged({
        change: "upsert",
        path: changedPath,
        reason: "acp.fs",
      });
    } finally {
      try {
        if (temporaryCreated && !committed) {
          await rm(temporaryPath, { force: true });
        }
      } finally {
        await path.directory.file.close();
      }
    }

    return {};
  }
}

async function readExistingMode(path: string): Promise<number> {
  try {
    const metadata = await lstat(path);
    return metadata.isFile() ? metadata.mode & 0o7777 : 0o600;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return 0o600;
    }
    throw error;
  }
}

async function readBoundedText(file: FileHandle, signal?: AbortSignal): Promise<string> {
  const decoder = new TextDecoder();
  const chunk = Buffer.allocUnsafe(FILE_CHUNK_BYTES);
  const content: string[] = [];
  let offset = 0;

  for (;;) {
    signal?.throwIfAborted();
    const remaining = MAX_ACP_FILE_BYTES + 1 - offset;

    if (remaining <= 0) {
      throw new Error(`ACP file exceeds ${MAX_ACP_FILE_BYTES} bytes.`);
    }

    const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, remaining), offset);
    if (bytesRead === 0) {
      content.push(decoder.decode());
      return content.join("");
    }

    offset += bytesRead;
    if (offset > MAX_ACP_FILE_BYTES) {
      throw new Error(`ACP file exceeds ${MAX_ACP_FILE_BYTES} bytes.`);
    }
    content.push(decoder.decode(chunk.subarray(0, bytesRead), { stream: true }));
  }
}
