import { describe, expect, test } from "bun:test";

import {
  applyCommittedMutation,
  cleanupObligationSchema,
  commandReceiptSchema,
  commandSchema,
  committedMutationSchema,
  extensionContentSchema,
  itemSchema,
  jsonRpcRequestSchema,
  jsonRpcSuccessSchema,
  mutationSyncSchema,
  normalizeExecutorMutation,
  validateCommand,
  validateSessionSnapshot,
} from "../src/contract";
import type {
  AuthorityOperation,
  CommittedMutation,
  Interaction,
  Item,
  Run,
  Session,
  SessionSnapshot,
} from "../src/contract";
import { createDriverId } from "../src/protocol/id";

const time = "2026-07-16T08:00:00.000Z";
const later = "2026-07-16T08:00:01.000Z";

function session(id = createDriverId()): Session {
  return {
    id,
    status: "open",
    createdAt: time,
    updatedAt: time,
    capabilities: {
      "interaction.input": {},
      "interaction.permission": {},
      "run.child": {},
    },
    config: [],
  };
}

function snapshot(sessionValue = session()): SessionSnapshot {
  return validateSessionSnapshot({
    protocolVersion: 3,
    revision: 0,
    capturedAt: time,
    session: sessionValue,
    runs: [],
    items: [],
    interactions: [],
  });
}

function activeRun(id = createDriverId()): Run {
  return {
    id,
    status: "active",
    origin: "user",
    input: [{ type: "text", text: "work" }],
    startedAt: time,
  };
}

function activeTool(runId: string, id = "tool-1"): Extract<Item, { kind: "tool" }> {
  return {
    id,
    runId,
    kind: "tool",
    status: "active",
    createdAt: time,
    updatedAt: time,
    audience: "participants",
    name: "shell",
    category: "execute",
    origin: "provider",
  };
}

function finishItem(item: Item, status: Exclude<Item["status"], "active">): Item {
  return {
    ...item,
    endedAt: time,
    ...(status === "failed"
      ? { error: { code: "test_failure", message: "failed", retryable: false } }
      : {}),
    status,
  };
}

function mutation(
  state: SessionSnapshot,
  operations: readonly AuthorityOperation[],
  committedAt = time,
): CommittedMutation {
  return committedMutationSchema.parse({
    mutationId: createDriverId(),
    sessionId: state.session.id,
    baseRevision: state.revision,
    revision: state.revision + 1,
    committedAt,
    cause: { type: "system", name: "test" },
    operations,
  });
}

function proposal(state: SessionSnapshot, operations: readonly AuthorityOperation[]) {
  return {
    baseRevision: state.revision,
    cause: { name: "provider-event", type: "system" as const },
    mutationId: createDriverId(),
    operations,
    sessionId: state.session.id,
  };
}

describe("contract closed core", () => {
  test("normalization preserves terminal status, error, and semantic identity for validation", () => {
    const initial = snapshot();
    const run = activeRun();
    const item = activeTool(run.id);
    const active = applyCommittedMutation(
      initial,
      mutation(initial, [
        { entity: "run", op: "put", value: run },
        { entity: "item", op: "put", value: item },
      ]),
    );
    const terminal = finishItem(item, "failed");
    const ended = applyCommittedMutation(
      active,
      mutation(active, [{ entity: "item", op: "put", value: terminal }]),
    );
    const clientAt = "2099-01-01T00:00:00.000Z";
    const content = itemSchema.parse({
      ...item,
      endedAt: clientAt,
      status: "completed",
      structuredOutput: { late: true },
      updatedAt: clientAt,
    });
    const cases = [
      {
        expected: { status: "completed" },
        message: "Item status cannot transition",
        value: content,
      },
      {
        expected: { error: { code: "changed" } },
        message: "terminal outcome fields cannot change",
        value: itemSchema.parse({
          ...terminal,
          endedAt: clientAt,
          error: { code: "changed", message: "changed", retryable: true },
          structuredOutput: { late: true },
          updatedAt: clientAt,
        }),
      },
      {
        expected: { origin: "host" },
        message: "identity fields cannot change",
        value: itemSchema.parse({
          ...terminal,
          endedAt: clientAt,
          origin: "host",
          structuredOutput: { late: true },
          updatedAt: clientAt,
        }),
      },
    ];

    for (const testCase of cases) {
      const normalized = normalizeExecutorMutation(
        ended,
        proposal(ended, [{ entity: "item", op: "put", value: testCase.value }]),
        later,
        1_000,
      );

      expect(normalized.operations[0]).toMatchObject({
        value: { ...testCase.expected, endedAt: terminal.endedAt },
      });
      expect(() =>
        applyCommittedMutation(ended, {
          ...normalized,
          committedAt: later,
          revision: ended.revision + 1,
        }),
      ).toThrow(testCase.message);
    }
  });

  test("rejects unknown commands and accepts namespaced content extensions", () => {
    expect(
      commandSchema.safeParse({
        commandId: createDriverId(),
        sessionId: createDriverId(),
        kind: "run.pause",
      }).success,
    ).toBe(false);
    expect(
      extensionContentSchema.parse({
        type: "extension",
        name: "example.org/widget",
        value: { state: "ready" },
      }),
    ).toMatchObject({ name: "example.org/widget" });
  });

  test.each([
    [
      "request params",
      () =>
        jsonRpcRequestSchema.parse({
          id: 1,
          jsonrpc: "2.0",
          method: "test",
          params: () => undefined,
        }),
    ],
    [
      "success result",
      () =>
        jsonRpcSuccessSchema.parse({
          id: 1,
          jsonrpc: "2.0",
          result: 1n,
        }),
    ],
  ])("rejects non-JSON JSON-RPC %s", (_label, parse) => {
    expect(parse).toThrow();
  });

  test("requires contiguous reliable mutation batches", () => {
    const state = snapshot();
    const first = mutation(state, [{ op: "put", entity: "run", value: activeRun() }]);

    expect(
      mutationSyncSchema.safeParse({
        type: "mutations",
        baseRevision: 0,
        throughRevision: 2,
        mutations: [first],
      }).success,
    ).toBe(false);
    expect(
      mutationSyncSchema.safeParse({
        type: "mutations",
        baseRevision: 0,
        throughRevision: 2,
        mutations: [first, { ...first, baseRevision: 1, revision: 2 }],
      }).success,
    ).toBe(false);
  });

  test("validates terminal Command receipts and cleanup deadlines", () => {
    expect(
      commandReceiptSchema.safeParse({
        commandId: createDriverId(),
        status: "accepted",
        duplicate: false,
        result: { ok: true },
      }).success,
    ).toBe(false);
    expect(
      cleanupObligationSchema.safeParse({
        id: createDriverId(),
        sessionId: createDriverId(),
        kind: "sandbox",
        resourceKey: "sandbox-1",
        releaseAfter: "2026-07-16T08:05:00.000Z",
        attempts: 0,
        nextAttemptAt: time,
      }).success,
    ).toBe(false);
  });

  test("validates Commands against current revision and Interaction content", () => {
    const initial = snapshot();
    expect(() =>
      validateCommand(
        initial,
        {
          commandId: createDriverId(),
          sessionId: initial.session.id,
          expectedRevision: 1,
          kind: "run.start",
          runId: createDriverId(),
          input: [{ type: "text", text: "work" }],
        },
        time,
      ),
    ).toThrow("expected revision 1");

    const run = activeRun();
    const interaction: Interaction = {
      id: createDriverId(),
      runId: run.id,
      kind: "input",
      status: "open",
      blocking: true,
      createdAt: time,
      expiresAt: "2026-07-16T08:05:00.000Z",
      audience: "participants",
      request: {
        questions: [{ id: "confirm", prompt: "Continue?", type: "confirm", required: true }],
      },
    };
    const waiting = applyCommittedMutation(
      initial,
      mutation(initial, [
        { op: "put", entity: "run", value: run },
        { op: "put", entity: "interaction", value: interaction },
      ]),
    );
    expect(() =>
      validateSessionSnapshot({
        ...waiting,
        interactions: [
          {
            ...interaction,
            request: {
              questions: [
                {
                  ...interaction.request.questions[0],
                  options: [],
                },
              ],
            },
          },
        ],
      }),
    ).toThrow();
    const resolve = {
      commandId: createDriverId(),
      sessionId: waiting.session.id,
      kind: "interaction.resolve",
      interactionId: interaction.id,
      resolution: {
        kind: "input",
        value: { type: "answered", answers: { confirm: ["true"] } },
      },
    };

    expect(validateCommand(waiting, resolve, time)).toMatchObject({
      kind: "interaction.resolve",
    });
    expect(() =>
      validateCommand(
        waiting,
        {
          ...resolve,
          resolution: {
            kind: "input",
            value: { type: "answered", answers: { confirm: ["maybe"] } },
          },
        },
        time,
      ),
    ).toThrow("must be true or false");
    expect(() => validateCommand(waiting, resolve, "2026-07-16T08:06:00.000Z")).toThrow(
      "has expired",
    );
    expect(() => validateCommand(waiting, resolve, interaction.expiresAt)).toThrow("has expired");
  });

  test("rejects a Command acceptance time before the current snapshot", () => {
    const current = validateSessionSnapshot({
      ...snapshot(),
      capturedAt: "2026-07-16T08:00:01.000Z",
    });

    expect(() =>
      validateCommand(
        current,
        {
          commandId: createDriverId(),
          input: [{ text: "work", type: "text" }],
          kind: "run.start",
          runId: createDriverId(),
          sessionId: current.session.id,
        },
        time,
      ),
    ).toThrow("cannot precede");
  });

  test("preserves sub-millisecond ordering when accepting Commands", () => {
    const current = validateSessionSnapshot({
      ...snapshot(),
      capturedAt: "2026-07-16T08:00:00.0000009Z",
    });

    expect(() =>
      validateCommand(
        current,
        {
          commandId: createDriverId(),
          input: [{ text: "work", type: "text" }],
          kind: "run.start",
          runId: createDriverId(),
          sessionId: current.session.id,
        },
        "2026-07-16T08:00:00.0000001Z",
      ),
    ).toThrow("cannot precede");
  });

  test("requires a negotiated capability for extension ContentBlocks", () => {
    const initial = snapshot();
    const command = {
      commandId: createDriverId(),
      input: [{ name: "example.org/widget", type: "extension" as const, value: {} }],
      kind: "run.start" as const,
      runId: createDriverId(),
      sessionId: initial.session.id,
    };

    expect(() => validateCommand(initial, command, time)).toThrow("was not negotiated");
    expect(
      validateCommand(
        {
          ...initial,
          session: {
            ...initial.session,
            capabilities: { ...initial.session.capabilities, "example.org/widget": {} },
          },
        },
        command,
        time,
      ),
    ).toMatchObject({ kind: "run.start" });
  });

  test("requires a negotiated capability for extension Items", () => {
    const initial = snapshot();
    const run = activeRun();
    const item = {
      audience: "participants" as const,
      createdAt: time,
      id: "extension-1",
      kind: "extension" as const,
      name: "example.org/widget",
      runId: run.id,
      status: "active" as const,
      updatedAt: time,
      value: {},
    };

    expect(() => validateSessionSnapshot({ ...initial, items: [item], runs: [run] })).toThrow(
      "was not negotiated",
    );
    expect(() =>
      validateSessionSnapshot({
        ...initial,
        items: [item],
        runs: [run],
        session: {
          ...initial.session,
          capabilities: { ...initial.session.capabilities, "example.org/widget": {} },
        },
      }),
    ).not.toThrow();
  });

  test.each([
    [
      "Run input",
      (run: Run, content: Run["input"]) => ({ items: [], runs: [{ ...run, input: content }] }),
    ],
    [
      "Item content",
      (run: Run, content: Run["input"]) => ({
        items: [
          {
            audience: "participants" as const,
            content,
            createdAt: time,
            id: "message-1",
            kind: "message" as const,
            role: "agent" as const,
            runId: run.id,
            status: "active" as const,
            updatedAt: time,
          },
        ],
        runs: [run],
      }),
    ],
  ] as const)("validates extension capabilities in %s", (_case, makeState) => {
    const initial = snapshot();
    const extension = { name: "example.org/widget", type: "extension" as const, value: {} };
    const run = activeRun();
    const { items, runs } = makeState(run, [extension]);

    expect(() => validateSessionSnapshot({ ...initial, items, runs })).toThrow(
      "was not negotiated",
    );
    expect(() =>
      validateSessionSnapshot({
        ...initial,
        items,
        runs,
        session: {
          ...initial.session,
          capabilities: { ...initial.session.capabilities, "example.org/widget": {} },
        },
      }),
    ).not.toThrow();
  });

  test("accepts free-text select answers only when the question allows them", () => {
    const initial = snapshot();
    const run = activeRun();
    const interaction: Interaction = {
      audience: "participants",
      blocking: true,
      createdAt: time,
      expiresAt: "2026-07-16T08:05:00.000Z",
      id: createDriverId(),
      kind: "input",
      request: {
        questions: [
          {
            allowOther: true,
            id: "mode",
            options: [{ id: "fast", label: "Fast" }],
            prompt: "Mode?",
            required: true,
            type: "single_select",
          },
        ],
      },
      runId: run.id,
      status: "open",
    };
    const waiting = applyCommittedMutation(
      initial,
      mutation(initial, [
        { entity: "run", op: "put", value: run },
        { entity: "interaction", op: "put", value: interaction },
      ]),
    );
    const command = {
      commandId: createDriverId(),
      interactionId: interaction.id,
      kind: "interaction.resolve" as const,
      resolution: {
        kind: "input" as const,
        value: { answers: { mode: ["careful"] }, type: "answered" as const },
      },
      sessionId: waiting.session.id,
    };

    expect(validateCommand(waiting, command, time)).toMatchObject({
      kind: "interaction.resolve",
    });
    expect(() =>
      validateCommand(
        {
          ...waiting,
          interactions: [
            {
              ...interaction,
              request: {
                questions: [{ ...interaction.request.questions[0], allowOther: undefined }],
              },
            },
          ],
        },
        command,
        time,
      ),
    ).toThrow("unknown choice");
  });

  test.each([
    {
      answers: { confirm: ["true"], mode: ["fast"] },
      error: null,
      name: "required answers with optional questions omitted",
    },
    {
      answers: {
        confirm: ["false"],
        features: ["search", "edit"],
        mode: ["slow"],
        note: ["careful"],
      },
      error: null,
      name: "all question kinds",
    },
    {
      answers: { mode: ["fast"] },
      error: "missing required question confirm",
      name: "missing required answer",
    },
    {
      answers: { confirm: ["true"], mode: ["fast"], unknown: ["value"] },
      error: "unknown question unknown",
      name: "unknown question",
    },
    {
      answers: { confirm: ["true"], mode: ["fast", "slow"] },
      error: "exactly one value",
      name: "multiple single-select values",
    },
    {
      answers: { confirm: ["true"], features: ["search", "search"], mode: ["fast"] },
      error: "duplicate choices",
      name: "duplicate multi-select values",
    },
    {
      answers: { confirm: ["true"], features: ["unknown"], mode: ["fast"] },
      error: "unknown choice",
      name: "unknown multi-select choice",
    },
    {
      answers: { confirm: ["maybe"], mode: ["fast"] },
      error: "must be true or false",
      name: "invalid confirmation",
    },
    {
      answers: { confirm: ["true"], mode: ["fast"], note: ["one", "two"] },
      error: "exactly one value",
      name: "multiple text values",
    },
  ] as const)("validates combined input answers: $name", ({ answers, error }) => {
    const initial = snapshot();
    const run = activeRun();
    const interaction: Interaction = {
      audience: "participants",
      blocking: true,
      createdAt: time,
      expiresAt: "2026-07-16T08:05:00.000Z",
      id: createDriverId(),
      kind: "input",
      request: {
        questions: [
          { id: "confirm", prompt: "Continue?", required: true, type: "confirm" },
          {
            id: "mode",
            options: [
              { id: "fast", label: "Fast" },
              { id: "slow", label: "Slow" },
            ],
            prompt: "Mode?",
            required: true,
            type: "single_select",
          },
          {
            id: "features",
            options: [
              { id: "search", label: "Search" },
              { id: "edit", label: "Edit" },
            ],
            prompt: "Features?",
            required: false,
            type: "multi_select",
          },
          { id: "note", prompt: "Notes?", required: false, type: "text" },
        ],
      },
      runId: run.id,
      status: "open",
    };
    const waiting = applyCommittedMutation(
      initial,
      mutation(initial, [
        { entity: "run", op: "put", value: run },
        { entity: "interaction", op: "put", value: interaction },
      ]),
    );
    const command = {
      commandId: createDriverId(),
      interactionId: interaction.id,
      kind: "interaction.resolve",
      resolution: { kind: "input", value: { answers, type: "answered" } },
      sessionId: waiting.session.id,
    };

    if (error === null) {
      expect(validateCommand(waiting, command, time)).toMatchObject({
        kind: "interaction.resolve",
      });
    } else {
      expect(() => validateCommand(waiting, command, time)).toThrow(error);
    }
  });

  test("requires configuration capability and an unused steer Item ID", () => {
    const configurable = session();
    configurable.config = [{ id: "mode", label: "Mode", type: "boolean", value: false }];
    const idle = snapshot(configurable);
    const configure = {
      commandId: createDriverId(),
      sessionId: idle.session.id,
      kind: "session.configure" as const,
      changes: [{ configId: "mode", value: true }],
    };

    expect(() => validateCommand(idle, configure, time)).toThrow("does not support configuration");

    const run = activeRun();
    const commandId = createDriverId();
    const steerInitial = snapshot({
      ...session(),
      capabilities: { "run.steer": {} },
    });
    const steering = applyCommittedMutation(
      steerInitial,
      mutation(steerInitial, [
        { op: "put", entity: "run", value: run },
        {
          op: "put",
          entity: "item",
          value: {
            id: commandId,
            runId: run.id,
            kind: "message",
            status: "completed",
            createdAt: time,
            updatedAt: time,
            endedAt: time,
            audience: "participants",
            role: "user",
            content: [{ type: "text", text: "earlier" }],
          },
        },
      ]),
    );

    expect(() =>
      validateCommand(
        steering,
        {
          commandId,
          sessionId: steering.session.id,
          kind: "run.steer",
          runId: run.id,
          input: [{ type: "text", text: "again" }],
        },
        time,
      ),
    ).toThrow("already exists");
  });
});
