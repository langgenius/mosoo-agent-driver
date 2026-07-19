import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export interface AcpPathScopeOptions {
  readonly allowedRoots: readonly string[];
  readonly cwd: string;
}

function contains(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export class AcpPathScope {
  readonly #cwd: string;
  readonly #roots: readonly string[];
  #realRoots: Promise<readonly string[]> | null = null;

  constructor(options: AcpPathScopeOptions) {
    this.#cwd = resolve(options.cwd);
    this.#roots = [options.cwd, ...options.allowedRoots].map((root) => resolve(options.cwd, root));
  }

  cwd(): string {
    return this.#cwd;
  }

  async resolveExisting(path: string, label: string): Promise<string> {
    const lexical = this.#resolveLexical(path, label);
    const canonical = await realpath(lexical);
    await this.#assertCanonical(canonical, path, label);
    return canonical;
  }

  async resolveWritable(path: string, label: string): Promise<string> {
    const lexical = this.#resolveLexical(path, label);
    let ancestor = lexical;

    for (;;) {
      try {
        await lstat(ancestor);
        break;
      } catch (error) {
        const parent = dirname(ancestor);
        if (parent === ancestor) {
          throw error;
        }
        ancestor = parent;
      }
    }

    const canonicalAncestor = await realpath(ancestor);
    await this.#assertCanonical(canonicalAncestor, path, label);
    return resolve(canonicalAncestor, relative(ancestor, lexical));
  }

  #resolveLexical(path: string, label: string): string {
    if (!isAbsolute(path)) {
      throw new Error(`${label} must be absolute: ${path}.`);
    }

    const candidate = resolve(this.#cwd, path);
    if (this.#roots.some((root) => contains(root, candidate))) {
      return candidate;
    }

    throw new Error(`${label} is outside the allowed roots: ${path}.`);
  }

  async #assertCanonical(candidate: string, requested: string, label: string): Promise<void> {
    const roots = await (this.#realRoots ??= Promise.all(
      this.#roots.map((root) => realpath(root)),
    ));
    if (!roots.some((root) => contains(root, candidate))) {
      throw new Error(`${label} resolves outside the allowed roots: ${requested}.`);
    }
  }
}
