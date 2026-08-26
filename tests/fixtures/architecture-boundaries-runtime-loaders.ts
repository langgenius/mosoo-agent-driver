import { getBuiltinModule as importedLoader } from "node:process";

import { process as localProcess } from "./architecture-boundaries-resolution.js";

const { getBuiltinModule: destructuredLoader } = process;
const builtinModuleKey = "getBuiltinModule" as const;

export function direct(): void {
  void process.getBuiltinModule("node:module");
}

export function imported(): void {
  void importedLoader("node:module");
}

export function destructured(): void {
  void destructuredLoader("node:module");
}

export function computed(): void {
  void process[builtinModuleKey]("node:module");
}

export function local(): void {
  void localProcess.getBuiltinModule("node:module");
}
