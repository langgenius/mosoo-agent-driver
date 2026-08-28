import { defineConfig } from "vite-plus";

function restrictImports(
  ...patterns: string[]
): ["error", { paths: string[]; patterns: { regex: string }[] }] {
  return [
    "error",
    {
      paths: ["module", "node:module"],
      patterns: patterns.map((regex) => ({ regex })),
    },
  ];
}

export default defineConfig({
  lint: {
    plugins: ["import", "typescript", "unicorn"],
    rules: {
      "import/no-commonjs": ["error", { allowConditionalRequire: false }],
      "import/no-cycle": ["error", { ignoreExternal: true, ignoreTypes: false }],
      "import/no-dynamic-require": ["error", { esmodule: true }],
      "no-restricted-imports": restrictImports(),
      "typescript/no-require-imports": "error",
      "unicorn/prefer-module": "error",
    },
    overrides: [
      {
        files: ["src/contract/**/*.ts"],
        rules: {
          "no-restricted-imports": restrictImports(
            "(^|/)(core|infrastructure|runtimes|stores|surfaces)(/|$)",
          ),
        },
      },
      {
        files: ["src/protocol/**/*.ts"],
        rules: {
          "no-restricted-imports": restrictImports(
            "(^|/)(core|infrastructure|runtimes)(/|$)",
            "(^|/)\\.\\./runtime-events(/|$)",
          ),
        },
      },
      {
        files: ["src/core/**/*.ts"],
        rules: {
          "no-restricted-imports": restrictImports(
            "(^|/)(infrastructure|stores|surfaces)(/|$)",
            "(^|/)runtimes/(acp|claude|openai)(/|$)",
          ),
        },
      },
      {
        files: [
          "src/runtimes/acp/**/*.ts",
          "src/runtimes/claude/**/*.ts",
          "src/runtimes/openai/**/*.ts",
        ],
        rules: {
          "no-restricted-imports": restrictImports("(^|/)(infrastructure|stores|surfaces)(/|$)"),
        },
      },
    ],
  },
  pack: {
    dts: { emitDtsOnly: true },
    entry: ["src/*.ts", "src/contract/index.ts"],
    fixedExtension: false,
    outDir: "dist/types",
    platform: "neutral",
  },
});
