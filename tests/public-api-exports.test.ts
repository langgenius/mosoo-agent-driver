import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as ts from "typescript";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const snapshotPath = resolve(repositoryRoot, "tests/public-api-exports.snapshot.json");

interface PackageManifest {
  readonly exports: Readonly<
    Record<
      string,
      {
        readonly default: string;
      }
    >
  >;
}

interface EntryExports {
  readonly types: readonly string[];
  readonly values: readonly string[];
}

type ExportSnapshot = Readonly<Record<string, EntryExports>>;

function compilerProgram(): ts.Program {
  const configPath = resolve(repositoryRoot, "tsconfig.json");
  const config = ts.readConfigFile(configPath, (path) => readFileSync(path, "utf8"));

  if (config.error !== undefined) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  }

  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, repositoryRoot);
  return ts.createProgram(parsed.fileNames, parsed.options);
}

function isTypeOnlyAlias(symbol: ts.Symbol): boolean {
  const declarations = symbol.declarations;

  return (
    declarations !== undefined &&
    declarations.length > 0 &&
    declarations.every((declaration) => {
      if (!ts.isExportSpecifier(declaration)) {
        return false;
      }

      return declaration.isTypeOnly || declaration.parent.parent.isTypeOnly;
    })
  );
}

function collectEntryExports(program: ts.Program, entryPath: string): EntryExports {
  const sourceFile = program.getSourceFile(entryPath);

  if (sourceFile === undefined) {
    throw new Error(`Public package entry is missing from the TypeScript program: ${entryPath}.`);
  }

  const checker = program.getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);

  if (moduleSymbol === undefined) {
    return { types: [], values: [] };
  }

  const types = new Set<string>();
  const values = new Set<string>();

  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const target =
      (exported.flags & ts.SymbolFlags.Alias) === 0 ? exported : checker.getAliasedSymbol(exported);
    const typeOnly = isTypeOnlyAlias(exported);

    if ((target.flags & ts.SymbolFlags.Type) !== 0) {
      types.add(exported.name);
    }

    if (!typeOnly && (target.flags & ts.SymbolFlags.Value) !== 0) {
      values.add(exported.name);
    }
  }

  return {
    types: [...types].toSorted(),
    values: [...values].toSorted(),
  };
}

function collectPublicExports(): ExportSnapshot {
  const manifest = JSON.parse(
    readFileSync(resolve(repositoryRoot, "package.json"), "utf8"),
  ) as PackageManifest;
  const program = compilerProgram();

  return Object.fromEntries(
    Object.entries(manifest.exports)
      .map(([entry, target]): [string, EntryExports] => [
        entry,
        collectEntryExports(program, resolve(repositoryRoot, target.default)),
      ])
      .toSorted(([left], [right]) => left.localeCompare(right)),
  );
}

test("public package entries preserve their complete value and type export sets", () => {
  const current = collectPublicExports();

  if (process.env["UPDATE_PUBLIC_EXPORT_SNAPSHOT"] === "1") {
    writeFileSync(snapshotPath, `${JSON.stringify(current, null, 2)}\n`);
  }

  const expected = JSON.parse(readFileSync(snapshotPath, "utf8")) as ExportSnapshot;
  expect(current).toEqual(expected);
});
