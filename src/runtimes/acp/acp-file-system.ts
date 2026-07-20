import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { AgentDriverContext } from "../../core/agent-driver-backend";
import { isRecord, raceWithAbort, readNonEmptyString, readNumber } from "./acp-types";
import { AcpPathScope } from "./acp-path-scope";

interface AcpFileSystemOptions {
  readonly allowedRoots: readonly string[];
  readonly cwd: string;
  readonly pathScope?: AcpPathScope | undefined;
}

const MAX_ACP_FILE_BYTES = 8 * 1_024 * 1_024;

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

    const path = await this.#pathScope.resolveExisting(requestedPath, "ACP file path");
    const file = await stat(path);
    signal?.throwIfAborted();

    if (!file.isFile()) {
      throw new Error("ACP fs/read_text_file requires a regular file.");
    }

    if (file.size > MAX_ACP_FILE_BYTES) {
      throw new Error(`ACP file exceeds ${MAX_ACP_FILE_BYTES} bytes.`);
    }

    const raw = await readFile(path, { encoding: "utf8", signal });
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

    const path = await this.#pathScope.resolveWritable(requestedPath, "ACP file path");
    await mkdir(dirname(path), { recursive: true });
    signal?.throwIfAborted();
    await writeFile(path, content, { encoding: "utf8", signal });
    await raceWithAbort(
      context.ports.file.reportChanged({
        change: "upsert",
        path,
        reason: "acp.fs",
      }),
      signal,
    );

    return {};
  }
}
