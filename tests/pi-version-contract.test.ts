import { expect, test } from "bun:test";

import manifest from "../package.json";

test("Given native Pi RPC, When local and image runtimes are installed, Then both pin Pi 1.0.0", async () => {
  expect(manifest.devDependencies["@earendil-works/pi-coding-agent"]).toBe("1.0.0");
  const containerfile = await Bun.file(new URL("../Containerfile", import.meta.url)).text();
  expect(containerfile).toContain("ARG PI_VERSION=1.0.0\n");
  const installed = await Bun.file(
    new URL("../package.json", import.meta.resolve("@earendil-works/pi-coding-agent")),
  ).json();
  expect(installed.version).toBe("1.0.0");
});
