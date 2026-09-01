import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
type SourceGraph = ReadonlyMap<string, ReadonlySet<string>>;

async function createSourceGraph(): Promise<SourceGraph> {
  const entrypoints = await Array.fromAsync(
    new Bun.Glob("src/**/*.ts").scan({ absolute: true, cwd: repositoryRoot, onlyFiles: true }),
  );
  const metafile = (
    await Bun.build({
      allowUnresolved: [],
      entrypoints,
      metafile: true,
      packages: "external",
      root: repositoryRoot,
      treeShaking: false,
    })
  ).metafile!;
  const inputs = new Set(Object.keys(metafile.inputs));
  const sourceFiles = new Set(
    [...inputs].filter((path) => path.startsWith("src/") && path.endsWith(".ts")),
  );
  const unsupportedInput = [...inputs].find(
    (path) =>
      !sourceFiles.has(path) &&
      path !== "package.json" &&
      !(path.startsWith("src/") && path.endsWith(".json")),
  );
  if (unsupportedInput !== undefined) {
    throw new Error(`Source import resolved to an unsupported file: ${unsupportedInput}.`);
  }

  return new Map(
    [...sourceFiles].map((file) => {
      const imports = metafile.inputs[file]!.imports;
      if (imports.some((dependency) => dependency.kind !== "import-statement")) {
        throw new Error(`Runtime module loaders are unsupported: ${file}.`);
      }
      return [
        file,
        new Set(
          imports.map((dependency) => dependency.path).filter((path) => sourceFiles.has(path)),
        ),
      ];
    }),
  );
}

function isWithin(path: string, directory: string): boolean {
  return path.startsWith(`src/${directory}/`);
}

function isProviderRuntime(path: string): boolean {
  return ["runtimes/acp", "runtimes/claude", "runtimes/openai"].some((directory) =>
    isWithin(path, directory),
  );
}

function reachableDependencies(
  graph: SourceGraph,
  file: string,
  reachable = new Set<string>(),
): ReadonlySet<string> {
  for (const dependency of graph.get(file) ?? []) {
    if (reachable.has(dependency)) {
      continue;
    }
    reachable.add(dependency);
    reachableDependencies(graph, dependency, reachable);
  }

  return reachable;
}

function boundaryViolations(graph: SourceGraph): string[] {
  const violations: string[] = [];

  for (const file of graph.keys()) {
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
        violations.push(`${file} -> ${dependency}`);
      }
    }
  }

  return violations.toSorted();
}

function compositionViolations(graph: SourceGraph): string[] {
  return [...graph.keys()]
    .filter((file) => !isWithin(file, "bin"))
    .filter((file) => {
      const dependencies = [...reachableDependencies(graph, file)];
      return (
        dependencies.some((dependency) => isWithin(dependency, "core")) &&
        dependencies.some(isProviderRuntime) &&
        dependencies.some((dependency) => isWithin(dependency, "infrastructure"))
      );
    })
    .toSorted();
}

function sourceDirectory(path: string): string {
  const parts = path.slice("src/".length).split("/");
  return parts.length === 1 ? "(entrypoints)" : parts[0]!;
}

function bidirectionalDirectories(graph: SourceGraph): string[] {
  const edges = new Set<string>();

  for (const file of graph.keys()) {
    const source = sourceDirectory(file);
    for (const dependency of graph.get(file) ?? []) {
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
  test("keeps transitive contract, protocol, core, and provider dependencies inward", () => {
    expect(boundaryViolations(graph)).toEqual([]);

    const core = "src/core/audit.ts";
    const wrapper = "src/audit/wrapper.ts";
    const provider = "src/runtimes/openai/audit.ts";

    expect(
      boundaryViolations(
        new Map([
          [core, new Set([wrapper])],
          [wrapper, new Set([provider])],
          [provider, new Set()],
        ]),
      ),
    ).toEqual(["src/core/audit.ts -> src/runtimes/openai/audit.ts"]);
  });

  test("keeps bin as the only transitive full runtime composition root", () => {
    expect(compositionViolations(graph)).toEqual([]);

    const root = "src/composition-audit.ts";
    const wrapper = "src/audit/wrapper.ts";
    const core = "src/core/audit.ts";
    const provider = "src/runtimes/openai/audit.ts";
    const infrastructure = "src/infrastructure/audit.ts";

    expect(
      compositionViolations(
        new Map([
          [root, new Set([wrapper])],
          [wrapper, new Set([core, provider, infrastructure])],
          [core, new Set()],
          [provider, new Set()],
          [infrastructure, new Set()],
        ]),
      ),
    ).toEqual(["src/audit/wrapper.ts", "src/composition-audit.ts"]);
  });

  test("has no bidirectional top-level source directory dependencies", () => {
    expect(bidirectionalDirectories(graph)).toEqual([]);
  });
});
