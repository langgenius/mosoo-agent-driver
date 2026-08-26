import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { API, SymbolFlags, type Project } from "typescript/unstable/async";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const snapshotPath = resolve(repositoryRoot, "tests/public-api-exports.snapshot.json");

interface PackageManifest {
  readonly exports: Readonly<Record<string, { readonly default: string }>>;
}

interface EntryExports {
  readonly types: readonly string[];
  readonly values: readonly string[];
}

type ExportSnapshot = Readonly<Record<string, EntryExports>>;

async function collectEntryExports(project: Project, entryPath: string): Promise<EntryExports> {
  const source = await project.program.getSourceFile(entryPath);

  if (source === undefined) {
    throw new Error(`Public package entry is missing: ${entryPath}.`);
  }

  const values = new Set(Object.keys(await import(pathToFileURL(entryPath).href)));
  const moduleSymbol = await project.checker.getSymbolAtLocation(source);

  if (moduleSymbol === undefined) {
    throw new Error(`Public package entry has no module symbol: ${entryPath}.`);
  }

  const types = new Set<string>();

  for (const exported of await project.checker.getExportsOfModule(moduleSymbol)) {
    const target =
      exported.flags & SymbolFlags.Alias
        ? await project.checker.getAliasedSymbol(exported)
        : exported;

    if (await project.checker.isUnknownSymbol(target)) {
      throw new Error(`Public API export ${exported.name} is unresolved.`);
    }

    if (target.flags & (SymbolFlags.Type | SymbolFlags.Namespace)) {
      types.add(exported.name);
    }
  }

  return { types: [...types].toSorted(), values: [...values].toSorted() };
}

test("public package entries preserve their complete value and type export sets", async () => {
  const configPath = resolve(repositoryRoot, "tsconfig.json");
  const api = new API({ cwd: repositoryRoot });

  try {
    const snapshot = await api.updateSnapshot({ openProjects: [configPath] });
    const project = snapshot.getProject(configPath);

    if (project === undefined) {
      throw new Error(`TypeScript project is missing: ${configPath}.`);
    }

    expect(
      await collectEntryExports(
        project,
        resolve(repositoryRoot, "tests/fixtures/public-api-type-namespace.ts"),
      ),
    ).toEqual({
      types: [
        "AuditBoth",
        "AuditDeclaredNamespace",
        "AuditDefault",
        "AuditMerged",
        "AuditNamespace",
        "AuditType",
        "AuditTypeNamespace",
        "Named",
        "TypeStarBoth",
        "TypeStarOnly",
        "default",
      ],
      values: [
        "AuditBoth",
        "AuditDefault",
        "AuditMerged",
        "AuditNamespace",
        "AuditValue",
        "default",
      ],
    });

    const manifest = JSON.parse(
      readFileSync(resolve(repositoryRoot, "package.json"), "utf8"),
    ) as PackageManifest;
    const current = Object.fromEntries(
      (
        await Promise.all(
          Object.entries(manifest.exports).map(
            async ([entry, target]) =>
              [
                entry,
                await collectEntryExports(project, resolve(repositoryRoot, target.default)),
              ] as const,
          ),
        )
      ).toSorted(([left], [right]) => left.localeCompare(right)),
    );

    if (process.env["UPDATE_PUBLIC_EXPORT_SNAPSHOT"] === "1") {
      writeFileSync(snapshotPath, `${JSON.stringify(current, null, 2)}\n`);
    }

    const expected = JSON.parse(readFileSync(snapshotPath, "utf8")) as ExportSnapshot;
    expect(current).toEqual(expected);
  } finally {
    await api.close();
  }
});
