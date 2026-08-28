import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

const generatedDir = resolve("src/runtimes/openai/generated");
const schemaDir = resolve("src/runtimes/openai/generated-json-schema");
const protocolTypesPath = resolve("src/runtimes/openai/app-server-protocol-types.ts");
const methodsPath = resolve(generatedDir, "ProtocolMethods.ts");

function readMethods(schemaName) {
  const schema = JSON.parse(readFileSync(resolve(schemaDir, `${schemaName}.json`), "utf8"));
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
  return `export type ${name} =\n${methods.map((method) => `  | ${JSON.stringify(method)}`).join("\n")};`;
}

writeFileSync(
  methodsPath,
  [
    "// GENERATED CODE! DO NOT MODIFY BY HAND!",
    "",
    "// Derived from the matching runtime JSON Schemas by scripts/prune-openai-generated-types.mjs.",
    renderUnion("ServerNotificationMethod", readMethods("ServerNotification")),
    "",
    renderUnion("ServerRequestMethod", readMethods("ServerRequest")),
    "",
  ].join("\n"),
);

function resolveImport(importer, specifier) {
  const unresolved = resolve(dirname(importer), specifier);
  const candidates = unresolved.endsWith(".ts")
    ? [unresolved]
    : [`${unresolved}.ts`, resolve(unresolved, "index.ts")];
  const file = candidates.find(existsSync);
  if (file === undefined) {
    throw new Error(`${relative(generatedDir, importer)} imports missing module ${specifier}.`);
  }

  const path = relative(generatedDir, file);
  if (path === ".." || path.startsWith(`..${sep}`)) {
    throw new Error(`${relative(generatedDir, importer)} imports outside the generated directory.`);
  }
  return file;
}

const protocolSource = readFileSync(protocolTypesPath, "utf8");
const protocolImportPattern = /\bfrom\s+["'](\.\/generated(?:\/[^"']+)?)['"]/gu;
const pending = [...protocolSource.matchAll(protocolImportPattern)].map((match) =>
  resolveImport(protocolTypesPath, match[1]),
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
    pending.push(resolveImport(file, match[1]));
  }
}

function listTypeScriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? listTypeScriptFiles(path) : path.endsWith(".ts") ? [path] : [];
  });
}

const files = listTypeScriptFiles(generatedDir);
for (const file of files) {
  if (!reachable.has(file)) {
    rmSync(file);
  }
}

console.log(`Kept ${reachable.size} of ${files.length} generated TypeScript files.`);
