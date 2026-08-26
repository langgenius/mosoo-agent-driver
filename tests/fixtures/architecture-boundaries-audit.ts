declare const moduleName: string;

void import("./" + moduleName);
void require("node:fs");
void ((load) => load("node:fs"))(require);
void import.meta.require("node:fs");
void import.meta["require"]("node:fs");
void module.exports;
void exports.value;
void require;
void module;
void exports;
void process.getBuiltinModule("node:module");
void process["getBuiltinModule"]("module");

// @ts-expect-error -- Exercises the CommonJS syntax guard.
import legacy = require("node:fs");
// @ts-expect-error -- Exercises the CommonJS syntax guard.
export = legacy;

import "node:module";
import "module";
