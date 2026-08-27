import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    dts: { emitDtsOnly: true },
    entry: ["src/*.ts", "src/contract/index.ts"],
    fixedExtension: false,
    outDir: "dist/types",
    platform: "neutral",
  },
});
