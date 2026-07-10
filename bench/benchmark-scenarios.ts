import type { PermissionDecision } from "../src/core/driver-permission-broker";
import type { DriverPermissionPolicy } from "../src/protocol/boot";

export type BenchmarkScenarioId =
  | "no_tool"
  | "long_output"
  | "tool_write_allow"
  | "tool_write_reject";

export interface BenchmarkScenario {
  readonly expect: string;
  readonly id: BenchmarkScenarioId;
  readonly marker?: { readonly content: string; readonly file: string };
  readonly permission: PermissionDecision;
  readonly policyExpectation?: "supervised_write_rejected";
  readonly permissionPolicy: DriverPermissionPolicy;
  readonly prompt: string;
  readonly systemPrompt: string;
}

export interface BenchmarkOutcomeInput {
  readonly fileCreated: boolean | null;
  readonly markerPresent: boolean | null;
  readonly permissionRequestCount: number;
  readonly scenario: BenchmarkScenario;
  readonly textCompleted: boolean;
}

export interface BenchmarkOutcome {
  readonly policyEnforced: boolean | null;
  readonly taskCompleted: boolean;
}

const TOOL_PROMPT =
  "Create a file named marker.txt in the current directory containing exactly the word ready, then reply with exactly: done.";
const TOOL_SYSTEM = "You are a coding agent. Use tools to complete the task, then reply concisely.";
const TOOL_MARKER = { file: "marker.txt", content: "ready" } as const;

export const BENCHMARK_SCENARIOS: readonly BenchmarkScenario[] = [
  {
    id: "no_tool",
    prompt: "Reply with exactly one lowercase word: pong. Do not call tools.",
    systemPrompt: "Reply with exactly one lowercase word: pong. Do not call tools.",
    permission: "allow_once",
    permissionPolicy: "full_access",
    expect: "pong",
  },
  {
    id: "long_output",
    prompt:
      "Without calling any tools, write a single paragraph of about 200 words describing how a compiler works. Plain prose only.",
    systemPrompt: "You are a helpful assistant. Do not call tools.",
    permission: "allow_once",
    permissionPolicy: "full_access",
    expect: "compiler",
  },
  {
    id: "tool_write_allow",
    prompt: TOOL_PROMPT,
    systemPrompt: TOOL_SYSTEM,
    permission: "allow_once",
    permissionPolicy: "full_access",
    expect: "done",
    marker: TOOL_MARKER,
  },
  {
    id: "tool_write_reject",
    prompt: TOOL_PROMPT,
    systemPrompt: TOOL_SYSTEM,
    permission: "reject_once",
    policyExpectation: "supervised_write_rejected",
    permissionPolicy: "supervised",
    expect: "done",
    marker: TOOL_MARKER,
  },
];

export function evaluateBenchmarkOutcome(input: BenchmarkOutcomeInput): BenchmarkOutcome {
  const taskCompleted =
    input.textCompleted && (input.scenario.marker === undefined || input.fileCreated === true);
  const policyEnforced =
    input.scenario.policyExpectation === "supervised_write_rejected"
      ? input.permissionRequestCount > 0 && input.markerPresent === false
      : null;

  return {
    policyEnforced,
    taskCompleted,
  };
}
