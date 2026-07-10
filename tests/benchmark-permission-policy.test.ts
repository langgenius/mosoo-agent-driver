import { describe, expect, test } from "bun:test";

import { aggregateBenchmarkTrials } from "../bench/benchmark-metrics";
import { applyBenchmarkPermissionPolicy } from "../bench/benchmark-permission-policy";
import { BENCHMARK_SCENARIOS, evaluateBenchmarkOutcome } from "../bench/benchmark-scenarios";
import type { BenchmarkScenario, BenchmarkScenarioId } from "../bench/benchmark-scenarios";
import { createDriverPermissionRequestHandler } from "../src/core/driver-permission-policy";
import { bootPayload } from "./driver-runtime-boundary-fixtures";

function requireScenario(id: BenchmarkScenarioId): BenchmarkScenario {
  const scenario = BENCHMARK_SCENARIOS.find((candidate) => candidate.id === id);
  if (scenario === undefined) {
    throw new Error(`Missing benchmark scenario: ${id}.`);
  }

  return scenario;
}

describe("benchmark permission policy", () => {
  test("binds the rejecting tool scenario to supervised execution", () => {
    const rejectScenario = requireScenario("tool_write_reject");
    const allowScenario = requireScenario("tool_write_allow");

    expect(rejectScenario).toMatchObject({
      permission: "reject_once",
      policyExpectation: "supervised_write_rejected",
      permissionPolicy: "supervised",
    });
    expect(allowScenario).toMatchObject({
      permission: "allow_once",
      permissionPolicy: "full_access",
    });
  });

  test("routes the reject scenario through the supervised host handler", async () => {
    const payload = applyBenchmarkPermissionPolicy(bootPayload, "supervised");
    let supervisedRequests = 0;
    const handler = createDriverPermissionRequestHandler({
      payload,
      supervised: async () => {
        supervisedRequests += 1;
        return "reject_once";
      },
    });

    const decision = await handler({
      rawInput: "{}",
      requestId: "benchmark-permission-request",
      title: "Write marker",
      toolCallId: "benchmark-tool-call",
      toolKind: "write",
    });

    expect(payload.execution.permissionPolicy).toBe("supervised");
    expect(decision).toBe("reject_once");
    expect(supervisedRequests).toBe(1);
  });

  test("preserves the fixture while changing only the permission policy", () => {
    const payload = applyBenchmarkPermissionPolicy(bootPayload, "supervised");

    expect(payload).not.toBe(bootPayload);
    expect(payload.execution).not.toBe(bootPayload.execution);
    expect(bootPayload.execution.permissionPolicy).toBe("full_access");
    expect(payload.execution).toEqual({
      ...bootPayload.execution,
      permissionPolicy: "supervised",
    });
  });

  test("treats an observed rejected write with no marker as enforced policy", () => {
    expect(
      evaluateBenchmarkOutcome({
        fileCreated: false,
        markerPresent: false,
        permissionRequestCount: 1,
        scenario: requireScenario("tool_write_reject"),
        textCompleted: true,
      }),
    ).toEqual({
      policyEnforced: true,
      taskCompleted: false,
    });
  });

  test("reports a marker written after rejection as a policy bypass", () => {
    expect(
      evaluateBenchmarkOutcome({
        fileCreated: true,
        markerPresent: true,
        permissionRequestCount: 1,
        scenario: requireScenario("tool_write_reject"),
        textCompleted: true,
      }),
    ).toEqual({
      policyEnforced: false,
      taskCompleted: true,
    });
  });

  test("does not infer enforcement from an absent marker without a permission request", () => {
    expect(
      evaluateBenchmarkOutcome({
        fileCreated: false,
        markerPresent: false,
        permissionRequestCount: 0,
        scenario: requireScenario("tool_write_reject"),
        textCompleted: false,
      }),
    ).toEqual({
      policyEnforced: false,
      taskCompleted: false,
    });
  });

  test("does not treat a marker with unexpected content as an absent marker", () => {
    expect(
      evaluateBenchmarkOutcome({
        fileCreated: false,
        markerPresent: true,
        permissionRequestCount: 1,
        scenario: requireScenario("tool_write_reject"),
        textCompleted: false,
      }),
    ).toEqual({
      policyEnforced: false,
      taskCompleted: false,
    });
  });

  test("keeps correctly rejected completed turns in latency aggregates", () => {
    const aggregate = aggregateBenchmarkTrials([
      {
        bootMs: 10,
        deltaCount: 2,
        error: null,
        fileCreated: false,
        firstTextMs: 25,
        interChunkMax: 3,
        interChunkP50: 2,
        interChunkP95: 3,
        markerPresent: false,
        outputChars: 12,
        permissionRequestCount: 1,
        policyEnforced: true,
        taskCompleted: false,
        totalMs: 40,
        ttftMs: 20,
      },
    ]);

    expect(aggregate).toMatchObject({
      policyEnforcedRate: 1,
      taskCompletedRate: 0,
      totalP50: 40,
      ttftP50: 20,
      turnCompletedRate: 1,
    });
  });
});
