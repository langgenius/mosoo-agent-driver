import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { mkdir, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

export interface AcpPathScopeOptions {
  readonly allowedRoots: readonly string[];
  readonly cwd: string;
}

export interface AcpPathHandle {
  readonly file: FileHandle;
  readonly procPath: string;
}

export interface AcpWritablePath {
  readonly directory: AcpPathHandle;
  readonly name: string;
}

interface AcpRootHandle extends AcpPathHandle {
  readonly lexical: string;
}

function contains(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function procPath(file: FileHandle): string {
  return `/proc/${process.pid}/fd/${file.fd}`;
}

async function closeRoots(roots: readonly AcpRootHandle[]): Promise<void> {
  const results = await Promise.allSettled(roots.map((root) => root.file.close()));
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );

  if (failures.length > 0) {
    throw new AggregateError(failures, "ACP path root capabilities failed to close.");
  }
}

export class AcpPathScope {
  readonly #configuredRoots: readonly string[];
  readonly #cwd: string;
  #closed = false;
  #closeTask: Promise<void> | null = null;
  #initializeTask: Promise<void> | null = null;
  #roots: readonly AcpRootHandle[] | null = null;

  constructor(options: AcpPathScopeOptions) {
    if (process.platform !== "linux") {
      throw new Error("ACP filesystem capabilities require Linux /proc support.");
    }

    this.#cwd = resolve(options.cwd);
    this.#configuredRoots = [
      ...new Set([options.cwd, ...options.allowedRoots].map((root) => resolve(options.cwd, root))),
    ].sort((left, right) => right.length - left.length);
  }

  cwd(): string {
    return this.#cwd;
  }

  initialize(): Promise<void> {
    if (this.#closed) {
      return Promise.reject(new Error("ACP path scope is closed."));
    }
    if (this.#roots !== null) {
      return Promise.resolve();
    }
    if (this.#initializeTask !== null) {
      return this.#initializeTask;
    }

    const task = this.#acquireRoots().finally(() => {
      if (this.#initializeTask === task) {
        this.#initializeTask = null;
      }
    });
    this.#initializeTask = task;
    return task;
  }

  close(): Promise<void> {
    this.#closed = true;
    if (this.#closeTask !== null) {
      return this.#closeTask;
    }

    const task = this.#close().finally(() => {
      if (this.#closeTask === task) {
        this.#closeTask = null;
      }
    });
    this.#closeTask = task;
    return task;
  }

  identify(handle: AcpPathHandle): Promise<string> {
    return realpath(handle.procPath);
  }

  async openFile(path: string, label: string): Promise<AcpPathHandle> {
    const resolved = await this.#resolve(path, label);
    return this.#openAt(
      resolved.root,
      join(resolved.root.procPath, resolved.relativePath),
      constants.O_RDONLY | constants.O_NONBLOCK,
      path,
      label,
    );
  }

  async openDirectory(path: string, label: string): Promise<AcpPathHandle> {
    const resolved = await this.#resolve(path, label);
    return this.#openAt(
      resolved.root,
      join(resolved.root.procPath, resolved.relativePath),
      constants.O_RDONLY | constants.O_DIRECTORY,
      path,
      label,
    );
  }

  async openWritable(path: string, label: string): Promise<AcpWritablePath> {
    const resolved = await this.#resolve(path, label);
    const segments = resolved.relativePath.split("/").filter((segment) => segment.length > 0);
    const name = segments.pop();

    if (name === undefined) {
      throw new Error(`${label} must name a file: ${path}.`);
    }

    let directory = await this.#openAt(
      resolved.root,
      resolved.root.procPath,
      constants.O_RDONLY | constants.O_DIRECTORY,
      path,
      label,
    );

    try {
      for (const segment of segments) {
        const child = join(directory.procPath, segment);
        let next: AcpPathHandle;

        try {
          next = await this.#openAt(
            resolved.root,
            child,
            constants.O_RDONLY | constants.O_DIRECTORY,
            path,
            label,
          );
        } catch (error) {
          if (!hasCode(error, "ENOENT")) {
            throw error;
          }

          try {
            await mkdir(child);
          } catch (mkdirError) {
            if (!hasCode(mkdirError, "EEXIST")) {
              throw mkdirError;
            }
          }
          next = await this.#openAt(
            resolved.root,
            child,
            constants.O_RDONLY | constants.O_DIRECTORY,
            path,
            label,
          );
        }

        await directory.file.close();
        directory = next;
      }

      return { directory, name };
    } catch (error) {
      await directory.file.close().catch(() => {});
      throw error;
    }
  }

  async #acquireRoots(): Promise<void> {
    const roots: AcpRootHandle[] = [];

    try {
      for (const lexical of this.#configuredRoots) {
        const file = await open(lexical, constants.O_RDONLY | constants.O_DIRECTORY);
        const root = { file, lexical, procPath: procPath(file) };
        roots.push(root);
        await realpath(root.procPath);

        if (this.#closed) {
          throw new Error("ACP path scope closed during initialization.");
        }
      }

      if (this.#closed) {
        throw new Error("ACP path scope closed during initialization.");
      }
      this.#roots = roots;
    } catch (error) {
      try {
        await closeRoots(roots);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "ACP path root capability initialization failed.",
        );
      }
      throw error;
    }
  }

  async #close(): Promise<void> {
    await this.#initializeTask?.catch(() => {});
    const roots = this.#roots;

    if (roots === null) {
      return;
    }

    await closeRoots(roots);
    if (this.#roots === roots) {
      this.#roots = null;
    }
  }

  async #resolve(
    path: string,
    label: string,
  ): Promise<{ readonly relativePath: string; readonly root: AcpRootHandle }> {
    if (!isAbsolute(path)) {
      throw new Error(`${label} must be absolute: ${path}.`);
    }

    const candidate = resolve(this.#cwd, path);
    const lexicalRoot = this.#configuredRoots.find((root) => contains(root, candidate));

    if (lexicalRoot === undefined) {
      throw new Error(`${label} is outside the allowed roots: ${path}.`);
    }

    await this.initialize();
    const root = this.#roots?.find((entry) => entry.lexical === lexicalRoot);

    if (root === undefined) {
      throw new Error("ACP path scope is not initialized.");
    }

    return {
      relativePath: relative(root.lexical, candidate),
      root,
    };
  }

  async #openAt(
    root: AcpRootHandle,
    path: string,
    flags: number,
    requested: string,
    label: string,
  ): Promise<AcpPathHandle> {
    const file = await open(path, flags);
    const handle = { file, procPath: procPath(file) };

    try {
      const [canonicalRoot, canonical] = await Promise.all([
        realpath(root.procPath),
        realpath(handle.procPath),
      ]);

      if (!contains(canonicalRoot, canonical)) {
        throw new Error(`${label} resolves outside the allowed roots: ${requested}.`);
      }

      return handle;
    } catch (error) {
      await file.close().catch(() => {});
      throw error;
    }
  }
}
