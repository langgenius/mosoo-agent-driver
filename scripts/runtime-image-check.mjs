import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const profile = readFileSync("/etc/mosoo/runtime", "utf8").trim();
const runtimes = JSON.parse(readFileSync("/etc/mosoo/runtime-images.json", "utf8"));
assert.ok(
  ["all", ...runtimes.map((runtime) => runtime.profile)].includes(profile),
  "Unknown runtime image profile",
);
const packageRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
for (const runtime of runtimes) {
  const selected = profile === "all" || profile === runtime.profile;
  assert.equal(
    existsSync(`${packageRoot}/${runtime.package}`),
    selected,
    `${runtime.package} package presence`,
  );
  const result = spawnSync(runtime.command, runtime.probe, { encoding: "utf8", timeout: 60_000 });
  if (selected) {
    assert.equal(result.status, 0, `${runtime.command}: ${result.error ?? result.stderr}`);
  } else {
    assert.equal(result.error?.code, "ENOENT", `${runtime.command} must be absent from ${profile}`);
  }
}
execFileSync("bun", ["--version"], { stdio: "inherit" });
execFileSync("node", ["/usr/local/libexec/mosoo/environment-package-manager-check.mjs", "verify"], {
  stdio: "inherit",
});
console.log(
  `Verified ${profile} runtime image (selected CLI, no unrelated runtimes, shared tools).`,
);
