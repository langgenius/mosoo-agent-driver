import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import { checkPiAcpImage } from "./pi-acp-image-check.mjs";

const profile = readFileSync("/etc/mosoo/runtime", "utf8").trim();
const runtimes = JSON.parse(readFileSync("/etc/mosoo/runtime-images.json", "utf8"));
assert.ok(
  ["all", ...runtimes.map((runtime) => runtime.profile)].includes(profile),
  "Unknown runtime image profile",
);
const packageRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
for (const runtime of runtimes) {
  const selected = profile === "all" || profile === runtime.profile;
  if (runtime.runtimeId === "pi-acp") {
    const launcher = spawnSync("/usr/local/bin/mosoo-pi", ["--version"], {
      encoding: "utf8",
      timeout: 60_000,
    });
    if (selected) {
      assert.equal(launcher.status, 0, `mosoo-pi: ${launcher.error ?? launcher.stderr}`);
      assert.equal(launcher.stdout.trim(), runtime.additionalPackages[0].version);
    } else {
      assert.equal(launcher.error?.code, "ENOENT", `mosoo-pi must be absent from ${profile}`);
    }
  }
  for (const entry of [runtime, ...(runtime.additionalPackages ?? [])]) {
    const installed = `${packageRoot}/${entry.package}`;
    assert.equal(existsSync(installed), selected, `${entry.package} package presence`);
    if (selected && entry.version) {
      const metadata = JSON.parse(readFileSync(`${installed}/package.json`, "utf8"));
      assert.equal(metadata.name, entry.package, `${entry.package} package identity`);
      assert.equal(metadata.version, entry.version, `${entry.package} exact version`);
      // gitHead records the public source revision in our manifest; npm tarballs
      // do not necessarily include it in the installed package.json.
    }
    if (selected && entry.package === "pi-acp") {
      assert.equal(
        createHash("sha256")
          .update(readFileSync(`${installed}/dist/index.js`))
          .digest("hex"),
        runtime.sourceSha256,
        "Pi ACP must contain the reviewed terminal-outcome patch",
      );
      await checkPiAcpImage(entry.command);
      continue;
    }
    const result = spawnSync(entry.command, entry.probe, {
      encoding: "utf8",
      timeout: 60_000,
    });
    if (selected) {
      assert.equal(result.status, 0, `${entry.command}: ${result.error ?? result.stderr}`);
      if (entry.version) {
        assert.equal(
          result.stdout.trim(),
          entry.version,
          `${entry.command} exact executable version`,
        );
      }
    } else {
      assert.equal(result.error?.code, "ENOENT", `${entry.command} must be absent from ${profile}`);
    }
  }
}
execFileSync("bun", ["--version"], { stdio: "inherit" });
execFileSync("node", ["/usr/local/libexec/mosoo/environment-package-manager-check.mjs", "verify"], {
  stdio: "inherit",
});
console.log(
  `Verified ${profile} runtime image (selected CLI, no unrelated runtimes, shared tools).`,
);
