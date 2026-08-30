import { describe, expect, test } from "bun:test";

import {
  DriverTerminalStateMachine,
  type DriverRunTerminalIdentity,
} from "../src/core/driver-terminal-state";
import { DriverTurnCancelledError } from "../src/core/driver-turn-cancelled-error";
import { DRIVER_TEST_IDS } from "./driver-boot-payload-fixture";

function terminal(
  status: "cancelled" | "completed" | "failed",
  sourceEventId = `terminal-${status}`,
): DriverRunTerminalIdentity {
  return {
    event:
      status === "failed"
        ? {
            kind: "run.failed",
            payload: { error: { code: "test.failed", message: "failed", retryable: false } },
            sourceEventId,
          }
        : status === "completed"
          ? {
              kind: "run.completed",
              payload: { stopReason: "end_turn" },
              sourceEventId,
            }
          : {
              kind: "run.cancelled",
              payload: { stopReason: "cancelled" },
              sourceEventId,
            },
    runId: DRIVER_TEST_IDS.runId,
    sourceEventId,
    status,
  };
}

function receipt(identity: DriverRunTerminalIdentity) {
  return { eventId: identity.sourceEventId, seq: 1, type: identity.event.kind };
}

describe("DriverTerminalStateMachine", () => {
  test("linearizes cancellation before a completed terminal", () => {
    const state = new DriverTerminalStateMachine();
    const ticket = state.beginRun(DRIVER_TEST_IDS.runId);

    expect(state.claimCancellation(ticket, "cancel first")).toBe("claimed");
    expect(state.claimCancellation(ticket, "again")).toBe("already_claimed");
    expect(ticket.signal.reason).toBeInstanceOf(DriverTurnCancelledError);
    expect(state.selectRunTerminal(ticket, terminal("completed"))).toBe("cancelled");
  });

  test("linearizes terminal selection before cancellation and requires its exact ACK", () => {
    const state = new DriverTerminalStateMachine();
    const ticket = state.beginRun(DRIVER_TEST_IDS.runId);
    const selected = terminal("completed");

    expect(state.selectRunTerminal(ticket, selected)).toBe("selected");
    expect(state.claimCancellation(ticket, "too late")).toBe("terminal_selected");
    expect(state.selectRunTerminal(ticket, structuredClone(selected))).toBe("pending");
    expect(() =>
      state.selectRunTerminal(ticket, {
        ...selected,
        event: { ...selected.event, payload: { stopReason: "other" } },
      }),
    ).toThrow("conflicts");
    expect(() => state.ackRunTerminal(ticket, { ...receipt(selected), eventId: "wrong" })).toThrow(
      "does not match",
    );

    state.ackRunTerminal(ticket, receipt(selected));
    expect(state.selectRunTerminal(ticket, selected)).toBe("acked");
    expect(state.snapshotRun()?.terminal?.phase).toBe("acked");
  });

  test("fails closed when cancellation has no acknowledged run terminal", () => {
    const state = new DriverTerminalStateMachine();
    const ticket = state.beginRun(DRIVER_TEST_IDS.runId);
    state.claimCancellation(ticket, "cancelled");

    const rejection = new Error("provider cleanup rejected");
    expect(state.settleInput(ticket, { error: rejection, status: "rejected" })).toEqual({
      failure: rejection,
      status: "failed",
    });
    expect(state.settleInput(ticket, { status: "resolved" })).toMatchObject({
      failure: { message: "Driver input settled without a run terminal." },
      status: "failed",
    });
  });

  test("keeps an acknowledged failed terminal authoritative over cancellation", () => {
    const state = new DriverTerminalStateMachine();
    const ticket = state.beginRun(DRIVER_TEST_IDS.runId);
    const failed = terminal("failed");
    state.claimCancellation(ticket, "cancelled");
    state.selectRunTerminal(ticket, failed);
    state.ackRunTerminal(ticket, receipt(failed));

    expect(
      state.settleInput(ticket, {
        error: new DriverTurnCancelledError("backend cancelled"),
        status: "cancelled",
      }),
    ).toMatchObject({
      failure: { message: "Driver cancellation settled with a failed run terminal." },
      status: "failed",
    });
  });

  test.each([
    ["cancelled + resolved", "cancelled", { status: "resolved" }, "failed"],
    [
      "cancelled + cancelled",
      "cancelled",
      { error: new DriverTurnCancelledError("backend cancelled"), status: "cancelled" },
      "cancelled",
    ],
    [
      "completed + cancelled",
      "completed",
      { error: new DriverTurnCancelledError("backend cancelled"), status: "cancelled" },
      "failed",
    ],
  ] as const)(
    "settles acknowledged %s without a cancellation claim",
    (_case, status, outcome, expected) => {
      const state = new DriverTerminalStateMachine();
      const ticket = state.beginRun(DRIVER_TEST_IDS.runId);
      const selected = terminal(status);
      state.selectRunTerminal(ticket, selected);
      state.ackRunTerminal(ticket, receipt(selected));

      expect(state.settleInput(ticket, outcome).status).toBe(expected);
    },
  );

  test("requires a selected terminal to be acknowledged before normal release", () => {
    const state = new DriverTerminalStateMachine();
    const ticket = state.beginRun(DRIVER_TEST_IDS.runId);
    const selected = terminal("completed");
    state.selectRunTerminal(ticket, selected);

    expect(state.settleInput(ticket, { status: "resolved" }).status).toBe("failed");
    expect(() => state.releaseRun(ticket, "command_acked")).toThrow("acknowledged terminal");
    state.ackRunTerminal(ticket, receipt(selected));
    expect(state.settleInput(ticket, { status: "resolved" })).toEqual({ status: "resolved" });
    state.releaseRun(ticket, "command_acked");
    expect(() => state.claimCancellation(ticket, "stale")).toThrow("stale");
  });

  test("cannot acknowledge a backend result without a durable run terminal", () => {
    const state = new DriverTerminalStateMachine();
    const ticket = state.beginRun(DRIVER_TEST_IDS.runId);

    expect(state.settleInput(ticket, { status: "resolved" })).toMatchObject({
      failure: { message: "Driver input settled without a run terminal." },
      status: "failed",
    });
    expect(() => state.releaseRun(ticket, "command_acked")).toThrow(
      "without an acknowledged terminal",
    );
    expect(() => state.releaseRun(ticket, "driver_failing")).not.toThrow();
  });

  test("keeps one exact instance terminal from selection through acknowledgement", () => {
    const state = new DriverTerminalStateMachine();
    const failure = {
      error: { code: "driver.failed", details: {}, message: "failed", retryable: false },
      runId: DRIVER_TEST_IDS.runId,
      status: "failed",
    } as const;

    expect(state.selectInstanceTerminal(failure)).toBe("selected");
    expect(state.selectInstanceTerminal(structuredClone(failure))).toBe("pending");
    expect(() =>
      state.selectInstanceTerminal({ runId: DRIVER_TEST_IDS.runId, status: "completed" }),
    ).toThrow("conflicts");
    state.ackInstanceTerminal(failure);
    expect(state.selectInstanceTerminal(failure)).toBe("acked");
    expect(() => state.beginRun(DRIVER_TEST_IDS.secondRunId)).toThrow("instance terminal");
  });

  test("freezes the exact run owner before a later run can replace it", () => {
    const state = new DriverTerminalStateMachine();
    const first = state.beginRun(DRIVER_TEST_IDS.runId);
    const selected = terminal("completed");
    state.selectRunTerminal(first, selected);
    state.ackRunTerminal(first, receipt(selected));
    state.releaseRun(first, "command_acked");

    expect(state.terminalRunId()).toBe(DRIVER_TEST_IDS.runId);
    expect(
      state.selectInstanceTerminal({ runId: state.terminalRunId()!, status: "completed" }),
    ).toBe("selected");
    expect(state.terminalRunId(DRIVER_TEST_IDS.secondRunId)).toBe(DRIVER_TEST_IDS.runId);
  });

  test("retains the shutdown failure owner after its run is released", () => {
    const state = new DriverTerminalStateMachine();
    const ticket = state.beginRun(DRIVER_TEST_IDS.runId);
    const error = { code: "driver.failed", details: {}, message: "failed", retryable: false };

    state.recordFailure(error);
    state.releaseRun(ticket, "driver_failing");
    state.markCleanupCompleted();
    expect(state.shutdownSnapshot()).toEqual({
      cleanup: "completed",
      failure: { error, runId: DRIVER_TEST_IDS.runId },
    });
  });

  test("retains the last owned run without a provider terminal", () => {
    const state = new DriverTerminalStateMachine();
    const ticket = state.beginRun(DRIVER_TEST_IDS.secondRunId);

    state.releaseRun(ticket, "driver_failing");

    expect(state.terminalRunId(DRIVER_TEST_IDS.runId)).toBe(DRIVER_TEST_IDS.secondRunId);
  });
});
