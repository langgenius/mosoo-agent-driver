import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import * as ts from "typescript";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceRoot = resolve(repositoryRoot, "src");

interface SourceGraph {
  readonly dependencies: ReadonlyMap<string, ReadonlySet<string>>;
  readonly files: readonly string[];
}

function loadCompilerOptions(): ts.CompilerOptions {
  const configPath = resolve(repositoryRoot, "tsconfig.json");
  const config = ts.readConfigFile(configPath, (path) => readFileSync(path, "utf8"));

  if (config.error !== undefined) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  }

  return ts.parseJsonConfigFileContent(config.config, ts.sys, repositoryRoot).options;
}

function moduleSpecifiers(sourceFile: ts.SourceFile): string[] {
  const specifiers: string[] = [];

  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0]!)
    ) {
      specifiers.push(node.arguments[0].text);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return specifiers;
}

function isSourceFile(path: string): boolean {
  return path === sourceRoot || path.startsWith(`${sourceRoot}${sep}`);
}

function createSourceGraph(): SourceGraph {
  const options = loadCompilerOptions();
  const config = ts.parseJsonConfigFileContent(
    ts.readConfigFile(resolve(repositoryRoot, "tsconfig.json"), (path) =>
      readFileSync(path, "utf8"),
    ).config,
    ts.sys,
    repositoryRoot,
  );
  const program = ts.createProgram(config.fileNames, options);
  const files = program
    .getSourceFiles()
    .map((sourceFile) => sourceFile.fileName)
    .filter((path) => isSourceFile(path) && !path.endsWith(".d.ts"))
    .toSorted();
  const fileSet = new Set(files);
  const dependencies = new Map<string, ReadonlySet<string>>();

  for (const file of files) {
    const sourceFile = program.getSourceFile(file);

    if (sourceFile === undefined) {
      throw new Error(`TypeScript program omitted ${file}.`);
    }

    const resolvedDependencies = new Set<string>();

    for (const specifier of moduleSpecifiers(sourceFile)) {
      const resolvedModule = ts.resolveModuleName(specifier, file, options, ts.sys).resolvedModule;
      const dependency = resolvedModule?.resolvedFileName;

      if (dependency !== undefined && fileSet.has(dependency)) {
        resolvedDependencies.add(dependency);
      }
    }

    dependencies.set(file, resolvedDependencies);
  }

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

function boundaryViolations(graph: SourceGraph): string[] {
  const violations: string[] = [];

  for (const file of graph.files) {
    for (const dependency of graph.dependencies.get(file) ?? []) {
      const forbidden =
        (isWithin(file, "contract") &&
          ["core", "runtimes", "infrastructure", "stores", "surfaces"].some((directory) =>
            isWithin(dependency, directory),
          )) ||
        (isWithin(file, "protocol") &&
          (["core", "runtimes", "infrastructure", "runtime-events"].some((directory) =>
            isWithin(dependency, directory),
          ) ||
            isWithin(dependency, "runtime-events"))) ||
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
      const dependencies = [...(graph.dependencies.get(file) ?? [])];
      return (
        dependencies.some((dependency) => isWithin(dependency, "core")) &&
        dependencies.some(isProviderRuntime) &&
        dependencies.some((dependency) => isWithin(dependency, "infrastructure"))
      );
    })
    .map(sourcePath)
    .toSorted();
}

function fileCycles(graph: SourceGraph): string[] {
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const stack: string[] = [];
  const cycles = new Set<string>();

  function visit(file: string): void {
    if (visited.has(file)) {
      return;
    }

    visiting.add(file);
    stack.push(file);

    for (const dependency of graph.dependencies.get(file) ?? []) {
      if (visiting.has(dependency)) {
        const start = stack.indexOf(dependency);
        cycles.add([...stack.slice(start), dependency].map(sourcePath).join(" -> "));
      } else {
        visit(dependency);
      }
    }

    stack.pop();
    visiting.delete(file);
    visited.add(file);
  }

  for (const file of graph.files) {
    visit(file);
  }

  return [...cycles].toSorted();
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

  const pairs = new Set<string>();

  for (const edge of edges) {
    const [source, target] = edge.split("\0") as [string, string];

    if (edges.has(`${target}\0${source}`)) {
      pairs.add([source, target].toSorted().join(" <-> "));
    }
  }

  return [...pairs].toSorted();
}

const graph = createSourceGraph();

describe("source architecture", () => {
  test("keeps contract, protocol, core, and provider imports pointing inward", () => {
    expect(boundaryViolations(graph)).toEqual([]);
  });

  test("keeps bin as the only full runtime composition root", () => {
    expect(compositionViolations(graph)).toEqual([]);
  });

  test("has no file-level import cycles", () => {
    expect(fileCycles(graph)).toEqual([]);
  });

  test("has no bidirectional top-level source directory dependencies", () => {
    expect(bidirectionalDirectories(graph)).toEqual([]);
  });
});
