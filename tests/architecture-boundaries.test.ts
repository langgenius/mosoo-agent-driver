import { describe, expect, test } from "bun:test";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const packageManifest = resolve(repositoryRoot, "package.json");
const sourceRoot = resolve(repositoryRoot, "src");
const transpiler = new Bun.Transpiler({ loader: "ts" });

interface SourceGraph {
  readonly dependencies: ReadonlyMap<string, ReadonlySet<string>>;
  readonly files: readonly string[];
}

function admitSourceDependency(
  importer: string,
  specifier: string,
  target: string,
  files: ReadonlySet<string>,
): string | undefined {
  if (target === packageManifest) {
    return undefined;
  }
  if (!target.startsWith(`${sourceRoot}${sep}`)) {
    throw new Error(
      `Source import resolves outside the source root: ${sourcePath(importer)} -> ${specifier}.`,
    );
  }
  if (target.endsWith(".json")) {
    return undefined;
  }
  if (!files.has(target)) {
    throw new Error(`Source import resolved to an unsupported file: ${sourcePath(target)}.`);
  }

  return target;
}

async function createSourceGraph(): Promise<SourceGraph> {
  const files = (
    await Array.fromAsync(
      new Bun.Glob("src/**/*.ts").scan({ absolute: true, cwd: repositoryRoot, onlyFiles: true }),
    )
  ).toSorted();
  const fileSet = new Set(files);
  const dependencies = new Map<string, ReadonlySet<string>>();

  await Promise.all(
    files.map(async (file) => {
      const source = (await Bun.file(file).text()).replace(/^#![^\n]*\n/, "");
      const resolved = new Set<string>();

      for (const dependency of transpiler.scanImports(source)) {
        if (dependency.kind !== "import-statement") {
          throw new Error(`Runtime module loaders are unsupported: ${sourcePath(file)}.`);
        }
        if (!dependency.path.startsWith(".")) {
          continue;
        }

        const target = Bun.resolveSync(dependency.path, dirname(file));
        const sourceDependency = admitSourceDependency(file, dependency.path, target, fileSet);
        if (sourceDependency !== undefined) {
          resolved.add(sourceDependency);
        }
      }

      dependencies.set(file, resolved);
    }),
  );

  return { dependencies, files };
}

function sourcePath(path: string): string {
  return relative(repositoryRoot, path).split(sep).join("/");
}

function isWithin(path: string, directory: string): boolean {
  const root = resolve(sourceRoot, directory);
  return path === root || path.startsWith(`${root}${sep}`);
}

function isProviderRuntime(path: string): boolean {
  return ["runtimes/acp", "runtimes/claude", "runtimes/openai"].some((directory) =>
    isWithin(path, directory),
  );
}

function reachableDependencies(graph: SourceGraph, file: string): ReadonlySet<string> {
  const reachable = new Set<string>();
  const pending = [...(graph.dependencies.get(file) ?? [])];

  for (const dependency of pending) {
    if (reachable.has(dependency)) {
      continue;
    }
    reachable.add(dependency);
    pending.push(...(graph.dependencies.get(dependency) ?? []));
  }

  return reachable;
}

function boundaryViolations(graph: SourceGraph): string[] {
  const violations: string[] = [];

  for (const file of graph.files) {
    for (const dependency of reachableDependencies(graph, file)) {
      const forbidden =
        (isWithin(file, "contract") &&
          ["core", "infrastructure", "runtimes", "stores", "surfaces"].some((directory) =>
            isWithin(dependency, directory),
          )) ||
        (isWithin(file, "protocol") &&
          ["core", "infrastructure", "runtimes", "runtime-events"].some((directory) =>
            isWithin(dependency, directory),
          )) ||
        (isWithin(file, "core") &&
          (isProviderRuntime(dependency) ||
            ["infrastructure", "stores", "surfaces"].some((directory) =>
              isWithin(dependency, directory),
            ))) ||
        (isProviderRuntime(file) &&
          ["infrastructure", "stores", "surfaces"].some((directory) =>
            isWithin(dependency, directory),
          ));

      if (forbidden) {
        violations.push(`${sourcePath(file)} -> ${sourcePath(dependency)}`);
      }
    }
  }

  return violations.toSorted();
}

function compositionViolations(graph: SourceGraph): string[] {
  return graph.files
    .filter((file) => !isWithin(file, "bin"))
    .filter((file) => {
      const dependencies = [...reachableDependencies(graph, file)];
      return (
        dependencies.some((dependency) => isWithin(dependency, "core")) &&
        dependencies.some(isProviderRuntime) &&
        dependencies.some((dependency) => isWithin(dependency, "infrastructure"))
      );
    })
    .map(sourcePath)
    .toSorted();
}

function sourceDirectory(path: string): string {
  const parts = relative(sourceRoot, path).split(sep);
  return parts.length === 1 ? "(entrypoints)" : parts[0]!;
}

function bidirectionalDirectories(graph: SourceGraph): string[] {
  const edges = new Set<string>();

  for (const file of graph.files) {
    const source = sourceDirectory(file);
    for (const dependency of graph.dependencies.get(file) ?? []) {
      const target = sourceDirectory(dependency);
      if (source !== target) {
        edges.add(`${source}\0${target}`);
      }
    }
  }

  return [...edges]
    .filter((edge) => {
      const [source, target] = edge.split("\0") as [string, string];
      return edges.has(`${target}\0${source}`);
    })
    .map((edge) => edge.split("\0").toSorted().join(" <-> "))
    .filter((pair, index, pairs) => pairs.indexOf(pair) === index)
    .toSorted();
}

const graph = await createSourceGraph();

describe("source architecture", () => {
  test("allows only source JSON leaves and the root package manifest outside the TS graph", () => {
    const importer = resolve(sourceRoot, "runtime.ts");
    const files = new Set([importer]);

    expect(
      admitSourceDependency(importer, "../package.json", packageManifest, files),
    ).toBeUndefined();
    expect(
      admitSourceDependency(importer, "./schema.json", resolve(sourceRoot, "schema.json"), files),
    ).toBeUndefined();
    expect(() =>
      admitSourceDependency(importer, "./README.md", resolve(sourceRoot, "README.md"), files),
    ).toThrow("unsupported file");
    expect(() =>
      admitSourceDependency(
        importer,
        "../schema.json",
        resolve(repositoryRoot, "schema.json"),
        files,
      ),
    ).toThrow("outside the source root");
  });

  test("keeps transitive contract, protocol, core, and provider dependencies inward", () => {
    expect(boundaryViolations(graph)).toEqual([]);

    const core = resolve(sourceRoot, "core/audit.ts");
    const wrapper = resolve(sourceRoot, "audit/wrapper.ts");
    const provider = resolve(sourceRoot, "runtimes/openai/audit.ts");

    expect(
      boundaryViolations({
        dependencies: new Map([
          [core, new Set([wrapper])],
          [wrapper, new Set([provider])],
          [provider, new Set()],
        ]),
        files: [core, wrapper, provider],
      }),
    ).toEqual(["src/core/audit.ts -> src/runtimes/openai/audit.ts"]);
  });

  test("keeps bin as the only transitive full runtime composition root", () => {
    expect(compositionViolations(graph)).toEqual([]);

    const root = resolve(sourceRoot, "composition-audit.ts");
    const wrapper = resolve(sourceRoot, "audit/wrapper.ts");
    const core = resolve(sourceRoot, "core/audit.ts");
    const provider = resolve(sourceRoot, "runtimes/openai/audit.ts");
    const infrastructure = resolve(sourceRoot, "infrastructure/audit.ts");

    expect(
      compositionViolations({
        dependencies: new Map([
          [root, new Set([wrapper])],
          [wrapper, new Set([core, provider, infrastructure])],
          [core, new Set()],
          [provider, new Set()],
          [infrastructure, new Set()],
        ]),
        files: [root, wrapper, core, provider, infrastructure],
      }),
    ).toEqual(["src/audit/wrapper.ts", "src/composition-audit.ts"]);
  });

  test("has no bidirectional top-level source directory dependencies", () => {
    expect(bidirectionalDirectories(graph)).toEqual([]);
  });
});
