import { rmSync } from "node:fs";

const distPath = new URL("../dist", import.meta.url);

rmSync(distPath, { force: true, recursive: true });
