import { describe, expect, test } from "bun:test";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { API, type Project } from "typescript/unstable/async";
import {
  SyntaxKind,
  type CallExpression,
  type Node,
  type SourceFile,
} from "typescript/unstable/ast";
import {
  isCallExpression,
  isElementAccessExpression,
  isExportAssignment,
  isExportDeclaration,
  isFunctionDeclaration,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isMetaProperty,
  isMethodSignatureDeclaration,
  isNamedExports,
  isNamedImports,
  isPropertyAccessExpression,
  isStringLiteralLikeNode,
} from "typescript/unstable/ast/is";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const packageManifestPath = resolve(repositoryRoot, "package.json");
const sourceRoot = resolve(repositoryRoot, "src");

interface SourceGraph {
  readonly dependencies: ReadonlyMap<string, ReadonlySet<string>>;
  readonly files: readonly string[];
}

interface ArchitectureAudit {
  readonly graph: SourceGraph;
  readonly resolutionDependencies: ReadonlySet<string>;
  readonly resolutionFixtureError: string | undefined;
  readonly runtimeLoaderFixtureErrors: ReadonlyMap<string, string | undefined>;
  readonly unsupportedFixtureErrors: readonly (string | undefined)[];
}

function sourcePath(path: string): string {
  return relative(repositoryRoot, path).split(sep).join("/");
}

function isImportMetaRequire(node: Node): boolean {
  if (!isPropertyAccessExpression(node) && !isElementAccessExpression(node)) {
    return false;
  }

  if (
    !isMetaProperty(node.expression) ||
    node.expression.keywordToken !== SyntaxKind.ImportKeyword
  ) {
    return false;
  }

  if (isPropertyAccessExpression(node)) {
    return node.name.text === "require";
  }

  return (
    isStringLiteralLikeNode(node.argumentExpression) && node.argumentExpression.text === "require"
  );
}

function isTypeOnlyModuleDeclaration(node: Node): boolean {
  if (isImportDeclaration(node)) {
    const clause = node.importClause;

    return (
      clause?.phaseModifier === SyntaxKind.TypeKeyword ||
      (clause?.name === undefined &&
        clause?.namedBindings !== undefined &&
        isNamedImports(clause.namedBindings) &&
        clause.namedBindings.elements.length > 0 &&
        clause.namedBindings.elements.every((element) => element.isTypeOnly))
    );
  }

  return (
    isExportDeclaration(node) &&
    (node.isTypeOnly ||
      (node.exportClause !== undefined &&
        isNamedExports(node.exportClause) &&
        node.exportClause.elements.length > 0 &&
        node.exportClause.elements.every((element) => element.isTypeOnly)))
  );
}

async function assertStaticEsm(project: Project, file: string, root: Node): Promise<void> {
  const commonJsIdentifiers: Node[] = [];
  const calls: CallExpression[] = [];

  function visit(node: Node): void {
    if (isCallExpression(node)) {
      if (node.expression.kind === SyntaxKind.ImportKeyword) {
        throw new Error(`Dynamic imports are unsupported: ${sourcePath(file)}.`);
      }

      calls.push(node);
    }

    if (isImportMetaRequire(node)) {
      throw new Error(`Runtime module loaders are unsupported: ${sourcePath(file)}.`);
    }

    if (
      (isImportDeclaration(node) || isExportDeclaration(node)) &&
      !isTypeOnlyModuleDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      isStringLiteralLikeNode(node.moduleSpecifier) &&
      ["module", "node:module"].includes(node.moduleSpecifier.text)
    ) {
      throw new Error(`Runtime module loaders are unsupported: ${sourcePath(file)}.`);
    }

    if (isImportEqualsDeclaration(node) || (isExportAssignment(node) && node.isExportEquals)) {
      throw new Error(`CommonJS syntax is unsupported: ${sourcePath(file)}.`);
    }

    if (
      isIdentifier(node) &&
      ["exports", "module", "require"].includes(node.text) &&
      !(isPropertyAccessExpression(node.parent) && node.parent.name === node)
    ) {
      commonJsIdentifiers.push(node);
    }

    node.forEachChild(visit);
  }

  visit(root);
  const symbols = await project.checker.getSymbolAtLocation(commonJsIdentifiers);
  const sourceFile = root.getSourceFile().fileName;

  for (const symbol of symbols) {
    if (
      symbol === undefined ||
      (await project.checker.isUnknownSymbol(symbol)) ||
      !symbol.declarations.some(({ path }) => path === sourceFile)
    ) {
      throw new Error(`CommonJS syntax is unsupported: ${sourcePath(file)}.`);
    }
  }

  for (const call of calls) {
    const declaration = (await project.checker.getResolvedSignature(call))?.declaration;

    if (
      declaration?.path.endsWith(`${sep}@types${sep}node${sep}process.d.ts`) &&
      declaration.kind === SyntaxKind.MethodSignature
    ) {
      const node = await declaration.resolve(project);

      if (
        node !== undefined &&
        isMethodSignatureDeclaration(node) &&
        isIdentifier(node.name) &&
        node.name.text === "getBuiltinModule"
      ) {
        throw new Error(`Runtime module loaders are unsupported: ${sourcePath(file)}.`);
      }
    }
  }
}

async function captureError(check: () => Promise<void>): Promise<string | undefined> {
  try {
    await check();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function isWorkspaceSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("#") ||
    specifier.startsWith("file:")
  );
}

function isDependencyPath(path: string): boolean {
  return path.includes(`${sep}node_modules${sep}`);
}

function admitSourceDependency(
  importer: string,
  specifier: string,
  target: string,
  files: ReadonlySet<string>,
): string | undefined {
  if (target === packageManifestPath) {
    return undefined;
  }

  if (target.startsWith(`${sourceRoot}${sep}`)) {
    if (!files.has(target)) {
      throw new Error(`Source import resolved to an unsupported file: ${sourcePath(target)}.`);
    }

    return target;
  }

  if (!isWorkspaceSpecifier(specifier) && isDependencyPath(target)) {
    return undefined;
  }

  throw new Error(
    `Source import resolves outside the source root: ${sourcePath(importer)} -> ${specifier}.`,
  );
}

async function resolveModuleDependencies(
  project: Project,
  importer: string,
  source: SourceFile,
  files: ReadonlySet<string>,
): Promise<ReadonlySet<string>> {
  const dependencies = new Set<string>();
  const moduleSpecifiers = [
    ...source.imports,
    ...source.moduleAugmentations.filter((node) => !(isIdentifier(node) && node.text === "global")),
  ];
  const symbols = await project.checker.getSymbolAtLocation(moduleSpecifiers);

  for (const [index, node] of moduleSpecifiers.entries()) {
    if (!isStringLiteralLikeNode(node)) {
      throw new Error(`Source import is not statically auditable: ${sourcePath(importer)}.`);
    }

    const symbol = symbols[index];

    if (symbol === undefined || (await project.checker.isUnknownSymbol(symbol))) {
      throw new Error(`Source import cannot be resolved: ${sourcePath(importer)} -> ${node.text}.`);
    }

    const declarations = symbol.declarations.filter(({ kind }) => kind === SyntaxKind.SourceFile);

    if (declarations.length === 0) {
      if (
        !isWorkspaceSpecifier(node.text) &&
        symbol.declarations.length > 0 &&
        symbol.declarations.every(({ path }) => isDependencyPath(path))
      ) {
        continue;
      }

      throw new Error(
        `Source import has no file declaration: ${sourcePath(importer)} -> ${node.text}.`,
      );
    }

    for (const declaration of declarations) {
      const dependency = admitSourceDependency(importer, node.text, declaration.path, files);

      if (dependency !== undefined) {
        dependencies.add(dependency);
      }
    }
  }

  for (const reference of source.referencedFiles) {
    const target = await project.program.getSourceFile(
      resolve(dirname(importer), reference.fileName),
    );

    if (target === undefined) {
      throw new Error(
        `Source reference cannot be resolved: ${sourcePath(importer)} -> ${reference.fileName}.`,
      );
    }

    const dependency = admitSourceDependency(importer, reference.fileName, target.fileName, files);

    if (dependency !== undefined) {
      dependencies.add(dependency);
    }
  }

  return dependencies;
}

async function getFixture(project: Project, name: string): Promise<SourceFile> {
  const fixture = await project.program.getSourceFile(
    resolve(repositoryRoot, `tests/fixtures/${name}.ts`),
  );

  if (fixture === undefined) {
    throw new Error(`TypeScript did not load the ${name} fixture.`);
  }

  return fixture;
}

async function createArchitectureAudit(): Promise<ArchitectureAudit> {
  const api = new API({ cwd: repositoryRoot });
  const configPath = resolve(repositoryRoot, "tsconfig.json");

  try {
    const snapshot = await api.updateSnapshot({ openProjects: [configPath] });
    const project = snapshot.getProject(configPath);

    if (project === undefined) {
      throw new Error(`TypeScript project is missing: ${configPath}.`);
    }

    const files = (await project.program.getSourceFileNames())
      .filter(
        (path) => path.startsWith(`${sourceRoot}${sep}`) && !/\.d\.(?:cts|mts|ts)$/.test(path),
      )
      .toSorted();
    const fileSet = new Set(files);
    const dependencies = new Map<string, ReadonlySet<string>>();

    await Promise.all(
      files.map(async (file) => {
        const source = await project.program.getSourceFile(file);

        if (source === undefined) {
          throw new Error(`TypeScript did not load ${sourcePath(file)}.`);
        }

        await assertStaticEsm(project, file, source);
        dependencies.set(file, await resolveModuleDependencies(project, file, source, fileSet));
      }),
    );

    const [auditFixture, resolutionFixture, runtimeLoaderFixture] = await Promise.all([
      getFixture(project, "architecture-boundaries-audit"),
      getFixture(project, "architecture-boundaries-resolution"),
      getFixture(project, "architecture-boundaries-runtime-loaders"),
    ]);
    const resolutionDependencies = await resolveModuleDependencies(
      project,
      resolutionFixture.fileName,
      resolutionFixture,
      fileSet,
    );
    const unsupportedFixtureErrors = await Promise.all(
      auditFixture.statements
        .slice(1)
        .map((statement) =>
          captureError(() => assertStaticEsm(project, auditFixture.fileName, statement)),
        ),
    );
    const resolutionFixtureError = await captureError(() =>
      assertStaticEsm(project, resolutionFixture.fileName, resolutionFixture),
    );
    const runtimeLoaderFixtureErrors = new Map(
      await Promise.all(
        runtimeLoaderFixture.statements
          .filter(isFunctionDeclaration)
          .map(
            async (statement) =>
              [
                statement.name!.text,
                await captureError(() =>
                  assertStaticEsm(project, runtimeLoaderFixture.fileName, statement),
                ),
              ] as const,
          ),
      ),
    );

    return {
      graph: { dependencies, files },
      resolutionDependencies,
      resolutionFixtureError,
      runtimeLoaderFixtureErrors,
      unsupportedFixtureErrors,
    };
  } finally {
    await api.close();
  }
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
    for (const dependency of reachableDependencies(graph, file)) {
      const forbidden =
        (isWithin(file, "contract") &&
          ["core", "runtimes", "infrastructure", "stores", "surfaces"].some((directory) =>
            isWithin(dependency, directory),
          )) ||
        (isWithin(file, "protocol") &&
          ["core", "runtimes", "infrastructure", "runtime-events"].some((directory) =>
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

function reachableDependencies(graph: SourceGraph, file: string): ReadonlySet<string> {
  const reachable = new Set<string>();
  const pending = [...(graph.dependencies.get(file) ?? [])];

  while (pending.length > 0) {
    const dependency = pending.pop()!;

    if (reachable.has(dependency)) {
      continue;
    }

    reachable.add(dependency);
    pending.push(...(graph.dependencies.get(dependency) ?? []));
  }

  return reachable;
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

  const pairs = new Set<string>();

  for (const edge of edges) {
    const [source, target] = edge.split("\0") as [string, string];

    if (edges.has(`${target}\0${source}`)) {
      pairs.add([source, target].toSorted().join(" <-> "));
    }
  }

  return [...pairs].toSorted();
}

const audit = await createArchitectureAudit();
const graph = audit.graph;

describe("source architecture", () => {
  test("uses TypeScript resolution for every dependency syntax", () => {
    expect(audit.resolutionDependencies).toEqual(
      new Set([
        resolve(sourceRoot, "contract/index.ts"),
        resolve(sourceRoot, "core/agent-driver-kernel.ts"),
        resolve(sourceRoot, "core/driver-runtime-state.ts"),
        resolve(sourceRoot, "paths.ts"),
      ]),
    );
  });

  test("allows only the exact root package manifest outside the source root", () => {
    const importer = resolve(sourceRoot, "runtime.ts");
    const files = new Set(graph.files);

    expect(admitSourceDependency(importer, "../package.json", packageManifestPath, files)).toBe(
      undefined,
    );
    expect(() =>
      admitSourceDependency(importer, "../README.md", resolve(repositoryRoot, "README.md"), files),
    ).toThrow("outside the source root");
  });

  test("rejects runtime-only module loading without rejecting static ESM or local names", () => {
    for (const error of audit.unsupportedFixtureErrors) {
      expect(error).toMatch(
        /(?:CommonJS syntax is|Dynamic imports are|Runtime module loaders are) unsupported/,
      );
    }
    expect(audit.resolutionFixtureError).toBeUndefined();
    for (const name of ["computed", "destructured", "direct", "imported"]) {
      expect(audit.runtimeLoaderFixtureErrors.get(name)).toContain(
        "Runtime module loaders are unsupported",
      );
    }
    expect(audit.runtimeLoaderFixtureErrors.get("local")).toBeUndefined();
  });

  test("keeps contract, protocol, core, and provider imports pointing inward", () => {
    expect(boundaryViolations(graph)).toEqual([]);

    const core = resolve(sourceRoot, "core/audit.ts");
    const wrapper = resolve(sourceRoot, "audit/wrapper.ts");
    const provider = resolve(sourceRoot, "runtimes/openai/audit.ts");
    const files = [core, wrapper, provider];
    const dependencies = new Map<string, ReadonlySet<string>>([
      [core, new Set([wrapper])],
      [wrapper, new Set([provider])],
      [provider, new Set()],
    ]);

    expect(boundaryViolations({ dependencies, files })).toEqual([
      "src/core/audit.ts -> src/runtimes/openai/audit.ts",
    ]);
  });

  test("keeps bin as the only transitive full runtime composition root", () => {
    expect(compositionViolations(graph)).toEqual([]);

    const root = resolve(sourceRoot, "composition-audit.ts");
    const wrapper = resolve(sourceRoot, "audit/wrapper.ts");
    const core = resolve(sourceRoot, "core/audit.ts");
    const provider = resolve(sourceRoot, "runtimes/openai/audit.ts");
    const infrastructure = resolve(sourceRoot, "infrastructure/audit.ts");
    const files = [root, wrapper, core, provider, infrastructure];
    const dependencies = new Map<string, ReadonlySet<string>>([
      [root, new Set([wrapper])],
      [wrapper, new Set([core, provider, infrastructure])],
      [core, new Set()],
      [provider, new Set()],
      [infrastructure, new Set()],
    ]);

    expect(compositionViolations({ dependencies, files })).toEqual([
      "src/audit/wrapper.ts",
      "src/composition-audit.ts",
    ]);
  });

  test("has no file-level dependency cycles", () => {
    expect(
      graph.files.filter((file) => reachableDependencies(graph, file).has(file)).map(sourcePath),
    ).toEqual([]);
  });

  test("has no bidirectional top-level source directory dependencies", () => {
    expect(bidirectionalDirectories(graph)).toEqual([]);
  });
});
