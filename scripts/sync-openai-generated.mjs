import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "..");
const generatedDir = resolve(root, "src/runtimes/openai/generated");
const schemaDir = resolve(root, "src/runtimes/openai/generated-json-schema");
const protocolTypesPath = resolve(root, "src/runtimes/openai/app-server-protocol-types.ts");
const checkOnly = process.argv.includes("--check");
const schemaSources = new Map([
  ["InitializeResponse.json", "v1/InitializeResponse.json"],
  ["ServerNotification.json", "ServerNotification.json"],
  ["ServerRequest.json", "ServerRequest.json"],
  ["ThreadBackgroundTerminalsCleanResponse.json", "v2/ThreadBackgroundTerminalsCleanResponse.json"],
  ["ThreadInjectItemsResponse.json", "v2/ThreadInjectItemsResponse.json"],
  ["ThreadResumeResponse.json", "v2/ThreadResumeResponse.json"],
  ["ThreadStartResponse.json", "v2/ThreadStartResponse.json"],
  ["TurnStartResponse.json", "v2/TurnStartResponse.json"],
]);

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      [result.stdout, result.stderr, `${command} exited with ${String(result.status)}.`]
        .filter(Boolean)
        .join("\n"),
    );
  }
}

function listFiles(directory, extension) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory()
        ? listFiles(path, extension)
        : path.endsWith(extension)
          ? [path]
          : [];
    })
    .sort();
}

function readMethods(stagedSchemaDir, schemaName) {
  const schema = JSON.parse(readFileSync(resolve(stagedSchemaDir, `${schemaName}.json`), "utf8"));
  if (!Array.isArray(schema.oneOf)) {
    throw new TypeError(`${schemaName}.json must contain a oneOf array.`);
  }

  const methods = schema.oneOf.map((branch, index) => {
    const values = branch?.properties?.method?.enum;
    if (values?.length !== 1 || typeof values[0] !== "string") {
      throw new TypeError(`${schemaName}.json oneOf[${index}] must have one method enum value.`);
    }
    return values[0];
  });
  if (new Set(methods).size !== methods.length) {
    throw new TypeError(`${schemaName}.json contains duplicate methods.`);
  }
  return methods;
}

function renderUnion(name, methods) {
  return `export type ${name} =\n${methods
    .map((method) => `  | ${JSON.stringify(method)}`)
    .join("\n")};`;
}

function writeProtocolMethods(stagedSchemaDir, stagedTypesDir) {
  writeFileSync(
    resolve(stagedTypesDir, "ProtocolMethods.ts"),
    [
      "// GENERATED CODE! DO NOT MODIFY BY HAND!",
      "",
      "// Derived from the matching runtime JSON Schemas by scripts/sync-openai-generated.mjs.",
      renderUnion("ServerNotificationMethod", readMethods(stagedSchemaDir, "ServerNotification")),
      "",
      renderUnion("ServerRequestMethod", readMethods(stagedSchemaDir, "ServerRequest")),
      "",
    ].join("\n"),
  );
}

function resolveImport(baseDir, importer, specifier) {
  const unresolved = resolve(dirname(importer), specifier);
  const candidates = unresolved.endsWith(".ts")
    ? [unresolved]
    : [`${unresolved}.ts`, resolve(unresolved, "index.ts")];
  const file = candidates.find(existsSync);
  if (file === undefined) {
    throw new Error(`${relative(baseDir, importer)} imports missing module ${specifier}.`);
  }

  const path = relative(baseDir, file);
  if (path === ".." || path.startsWith(`..${sep}`)) {
    throw new Error(`${relative(baseDir, importer)} imports outside the generated directory.`);
  }
  return file;
}

function pruneTypes(stagedTypesDir) {
  const protocolSource = readFileSync(protocolTypesPath, "utf8");
  const protocolImportPattern = /\bfrom\s+["']\.\/generated(?:\/([^"']+))?["']/gu;
  const protocolFile = resolve(stagedTypesDir, "__protocol__.ts");
  const pending = [...protocolSource.matchAll(protocolImportPattern)].map((match) =>
    resolveImport(stagedTypesDir, protocolFile, `./${match[1] ?? "index"}`),
  );
  if (pending.length === 0) {
    throw new Error("app-server-protocol-types.ts must import at least one generated type.");
  }

  const reachable = new Set();
  const relativeImportPattern = /\b(?:from\s+|import\s*\()\s*["'](\.[^"']+)["']/gu;
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || reachable.has(file)) {
      continue;
    }
    reachable.add(file);
    for (const match of readFileSync(file, "utf8").matchAll(relativeImportPattern)) {
      pending.push(resolveImport(stagedTypesDir, file, match[1]));
    }
  }

  for (const file of listFiles(stagedTypesDir, ".ts")) {
    if (!reachable.has(file)) {
      rmSync(file);
    }
  }
  return reachable.size;
}

function replaceFiles(sourceDir, targetDir, extension) {
  for (const file of listFiles(targetDir, extension)) {
    rmSync(file);
  }
  for (const file of listFiles(sourceDir, extension)) {
    const target = resolve(targetDir, relative(sourceDir, file));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(file, target);
  }
}

function assertFilesMatch(expectedDir, actualDir, extension) {
  const expected = listFiles(expectedDir, extension).map((file) => relative(expectedDir, file));
  const actual = listFiles(actualDir, extension).map((file) => relative(actualDir, file));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Generated ${extension} file set is stale.`);
  }
  for (const path of expected) {
    if (
      readFileSync(resolve(expectedDir, path), "utf8") !==
      readFileSync(resolve(actualDir, path), "utf8")
    ) {
      throw new Error(`Generated file ${path} is stale.`);
    }
  }
}

const temporaryRoot = mkdtempSync(join(tmpdir(), "mosoo-openai-generated-"));
try {
  const completeSchemas = resolve(temporaryRoot, "complete-schemas");
  const completeTypes = resolve(temporaryRoot, "complete-types");
  const stagedSchemas = resolve(temporaryRoot, "schemas");
  const stagedTypes = resolve(temporaryRoot, "types");
  mkdirSync(stagedSchemas);
  run(resolve(root, "node_modules/.bin/codex"), [
    "app-server",
    "generate-json-schema",
    "--experimental",
    "--out",
    completeSchemas,
  ]);
  run(resolve(root, "node_modules/.bin/codex"), [
    "app-server",
    "generate-ts",
    "--experimental",
    "--out",
    completeTypes,
  ]);

  for (const [target, source] of schemaSources) {
    copyFileSync(resolve(completeSchemas, source), resolve(stagedSchemas, target));
  }
  cpSync(completeTypes, stagedTypes, { recursive: true });
  writeProtocolMethods(stagedSchemas, stagedTypes);
  const retainedTypes = pruneTypes(stagedTypes);
  run(resolve(root, "node_modules/.bin/vp"), ["fmt", stagedSchemas, stagedTypes]);

  if (checkOnly) {
    assertFilesMatch(stagedSchemas, schemaDir, ".json");
    assertFilesMatch(stagedTypes, generatedDir, ".ts");
    console.log(`Verified 8 schemas and ${String(retainedTypes)} generated TypeScript files.`);
  } else {
    replaceFiles(stagedSchemas, schemaDir, ".json");
    replaceFiles(stagedTypes, generatedDir, ".ts");
    console.log(`Synchronized 8 schemas and ${String(retainedTypes)} generated TypeScript files.`);
  }
} finally {
  rmSync(temporaryRoot, { force: true, recursive: true });
}
