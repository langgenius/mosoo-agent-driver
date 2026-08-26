// oxlint-disable-next-line typescript/triple-slash-reference -- Exercises dependency auditing.
/// <reference path="../../src/core/driver-runtime-state.ts" />

import packageMetadata from "../../package.json" with { type: "json" };
import "../../src/paths.js";
import type { Module } from "node:module";

export type { Command } from "../../src/contract/index.js";
export type { Module as ExportedNodeModule } from "node:module";
export type ImportedNodeModule = Module;
export const moduleUrl = import.meta.url;

const require = () => packageMetadata.name;
const module = packageMetadata.name;
const exports = packageMetadata.name;
export const process = { getBuiltinModule: (_name: string) => packageMetadata.name };

void packageMetadata;
void require();
void module;
void exports;
void process.getBuiltinModule("node:module");
void { exports: packageMetadata.name, module, require };

declare module "../../src/core/agent-driver-kernel.ts" {}
