import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mode = process.argv[2] ?? "smoke";
const manifestPath =
  process.env.MOSOO_ENVIRONMENT_PACKAGE_MANAGER_MANIFEST ??
  "/etc/mosoo/environment-package-managers.json";
const SEMANTIC_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readManifest() {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    fail(
      `Invalid Environment package-manager manifest: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (manifest?.schemaVersion !== 1) {
    fail("Invalid Environment package-manager manifest: schemaVersion must be 1");
  }
  if (!Array.isArray(manifest.managers) || manifest.managers.length === 0) {
    fail("Invalid Environment package-manager manifest: managers must be a non-empty array");
  }

  const seen = new Set();
  for (const manager of manifest.managers) {
    if (typeof manager !== "string" || !/^[a-z][a-z0-9-]*$/.test(manager)) {
      fail(`Invalid Environment package-manager manifest: invalid manager ${String(manager)}`);
    }
    if (seen.has(manager)) {
      fail(`Invalid Environment package-manager manifest: duplicate manager ${manager}`);
    }
    seen.add(manager);
  }

  return manifest.managers;
}

function readCommandOutput(command, args, options = {}) {
  try {
    return execFileSync(command, args, { encoding: "utf8", ...options }).trim();
  } catch (error) {
    fail(`${command} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function runCommand(command, args, options = {}) {
  try {
    execFileSync(command, args, { stdio: "inherit", ...options });
  } catch (error) {
    fail(`${command} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function withTemporaryRoot(manager, callback) {
  const root = mkdtempSync(join(tmpdir(), `mosoo-environment-${manager}-`));

  try {
    callback(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function assertExactVersion(tool, expected, actual) {
  if (actual !== expected) {
    fail(`${tool} version mismatch: expected ${expected}, got ${actual}`);
  }
}

function assertSemanticVersion(tool, version) {
  if (!SEMANTIC_VERSION.test(version)) {
    fail(`${tool} returned an invalid version: ${version || "<empty>"}`);
  }
  return version;
}

function readSemanticVersion(tool, command, args, prefix = "") {
  const output = readCommandOutput(command, args);
  if (!output.startsWith(prefix)) {
    fail(`${tool} returned an invalid version: ${output || "<empty>"}`);
  }
  return assertSemanticVersion(tool, output.slice(prefix.length));
}

function readPipVersion(tool, command, args) {
  const output = readCommandOutput(command, args);
  const match = /^pip (\S+) /u.exec(output);
  return assertSemanticVersion(tool, match?.[1] ?? "");
}

function assertMatchingVersions(leftTool, leftVersion, rightTool, rightVersion) {
  if (leftVersion !== rightVersion) {
    fail(`${leftTool} and ${rightTool} versions do not match: ${leftVersion} != ${rightVersion}`);
  }
}

const managerChecks = new Map([
  [
    "npm",
    {
      verify() {
        const nodeVersion = readSemanticVersion("node", "node", ["--version"], "v");
        const npmVersion = readSemanticVersion("npm", "npm", ["--version"]);
        console.log(`Verified node ${nodeVersion} and npm ${npmVersion}.`);
      },
      smoke() {
        withTemporaryRoot("npm", (root) => {
          const npmRoot = join(root, "npm");
          runCommand("npm", [
            "install",
            "--prefix",
            npmRoot,
            "--no-audit",
            "--no-fund",
            "--save-exact",
            "prettier@3.3.3",
          ]);
          assertExactVersion(
            "prettier",
            "3.3.3",
            readCommandOutput(join(npmRoot, "node_modules", ".bin", "prettier"), ["--version"]),
          );
        });
      },
    },
  ],
  [
    "pip",
    {
      verify() {
        const pythonVersion = readSemanticVersion("python", "python", ["--version"], "Python ");
        const python3Version = readSemanticVersion("python3", "python3", ["--version"], "Python ");
        assertMatchingVersions("python", pythonVersion, "python3", python3Version);

        const pipVersion = readPipVersion("pip", "pip", ["--version"]);
        const modulePipVersion = readPipVersion("python -m pip", "python", [
          "-m",
          "pip",
          "--version",
        ]);
        assertMatchingVersions("pip", pipVersion, "python -m pip", modulePipVersion);
        console.log(`Verified python ${pythonVersion} and pip ${pipVersion}.`);
      },
      smoke() {
        withTemporaryRoot("pip", (root) => {
          const pipRoot = join(root, "python");
          runCommand("python", [
            "-m",
            "pip",
            "install",
            "--disable-pip-version-check",
            "--no-input",
            "--ignore-installed",
            "--prefix",
            pipRoot,
            "six==1.16.0",
          ]);
          const pythonSite = readCommandOutput("python", [
            "-c",
            'import sys,sysconfig; p=sys.argv[1]; print(sysconfig.get_path("purelib",vars={"base":p,"platbase":p}))',
            pipRoot,
          ]);
          runCommand("python", ["-c", 'import six; assert six.__version__ == "1.16.0"'], {
            env: { ...process.env, PYTHONPATH: pythonSite },
          });
        });
      },
    },
  ],
]);

if (mode !== "verify" && mode !== "smoke") {
  fail(`Unsupported Environment package-manager check mode: ${mode}`);
}

for (const manager of readManifest()) {
  const check = managerChecks.get(manager);
  if (!check) {
    fail(`Environment package manager has no ${mode} check: ${manager}`);
  }
  check[mode]();
}
