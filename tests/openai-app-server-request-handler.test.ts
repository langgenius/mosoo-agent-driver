import { expect, test } from "bun:test";

import { createAgentDriverContext } from "../src/core/agent-driver-backend";
import { PermissionEventDeliveryError } from "../src/core/driver-permission-broker";
import type { DriverPermissionRequest } from "../src/host-ports";
import { createDisabledLogger } from "../src/observability";
import { OpenAiAppServerRequestHandler } from "../src/runtimes/openai/app-server-request-handler";
import { driverStartInput } from "./driver-boot-payload-fixture";

test("OpenAI server request callbacks handle, reject, and cancel explicitly", async () => {
  const permissionStarted = Promise.withResolvers<void>();
  const permissionInputs: DriverPermissionRequest[] = [];
  const permissionSignals: AbortSignal[] = [];
  const responses: Array<{ id: string | number; result: unknown }> = [];
  const rejections: Array<{ id: string | number; message: string }> = [];
  const errors: Error[] = [];
  const context = createAgentDriverContext({
    eventSink: {
      currentRunId: () => null,
      pushEvents: async () => ({ accepted: [] }),
    },
    logger: createDisabledLogger(),
    payload: driverStartInput,
    permission: {
      request: async (input, signal) => {
        const requestSignal = signal ?? new AbortController().signal;
        permissionInputs.push(input);
        permissionSignals.push(requestSignal);
        if (permissionInputs.length === 4) {
          permissionStarted.resolve();
        }
        if (input.toolKind === "item/permissions/requestApproval") {
          return "allow_once";
        }
        if (input.toolKind === "item/commandExecution/requestApproval") {
          return "allow_once";
        }
        return await new Promise<"allow_once">((_resolve, reject) => {
          requestSignal.addEventListener("abort", () => reject(requestSignal.reason), {
            once: true,
          });
        });
      },
    },
  });
  const handler = new OpenAiAppServerRequestHandler({
    context,
    handleError: async (error) => {
      errors.push(error);
    },
    isStopped: () => false,
    mapToolCallId: (toolCallId) => toolCallId,
    respond: (id, result) => responses.push({ id, result }),
    respondError: (id, message) => rejections.push({ id, message }),
  });

  try {
    handler.dispatch("currentTime/read", 1, { threadId: "thread-1" });
    handler.dispatch("attestation/generate", 2, {});
    handler.dispatch("applyPatchApproval", 6, {});
    handler.dispatch("execCommandApproval", 7, {});
    handler.dispatch("item/commandExecution/requestApproval", 3, {
      additionalPermissions: {
        fileSystem: { write: ["/secrets"] },
        network: { enabled: true },
      },
      command: "npm test",
      cwd: "/workspace",
      availableDecisions: [
        "acceptForSession",
        {
          acceptWithExecpolicyAmendment: {
            execpolicy_amendment: ["npm", "test"],
          },
        },
        "cancel",
      ],
      itemId: "tool-1",
    });
    handler.dispatch("item/commandExecution/requestApproval", "3", {
      command: "npm test",
      itemId: "tool-string-3",
    });
    handler.dispatch("item/fileChange/requestApproval", 4, {
      grantRoot: "/workspace",
      itemId: "tool-2",
      reason: "Apply changes",
    });
    handler.dispatch("item/permissions/requestApproval", 5, {
      cwd: "/workspace",
      environmentId: "sandbox-1",
      permissions: { fileSystem: { read: ["/workspace"] }, network: null },
      reason: "Install dependencies",
    });
    await permissionStarted.promise;
    await handler.abortAll(new Error("turn cancelled"));

    expect(responses).toEqual(
      expect.arrayContaining([
        { id: 1, result: { currentTimeAt: expect.any(Number) } },
        { id: 3, result: { decision: "cancel" } },
        { id: "3", result: { decision: "accept" } },
        {
          id: 5,
          result: {
            permissions: { fileSystem: { read: ["/workspace"] } },
            scope: "turn",
          },
        },
      ]),
    );
    expect(rejections).toEqual([
      { id: 2, message: "Unsupported OpenAi app-server request: attestation/generate." },
      { id: 6, message: "Unsupported OpenAi app-server request: applyPatchApproval." },
      { id: 7, message: "Unsupported OpenAi app-server request: execCommandApproval." },
    ]);
    expect(permissionSignals.filter((signal) => signal.aborted)).toHaveLength(1);
    expect(permissionInputs.map(({ rawInput }) => JSON.parse(rawInput ?? "null"))).toEqual([
      expect.objectContaining({
        additionalPermissions: {
          fileSystem: { write: ["/secrets"] },
          network: { enabled: true },
        },
        command: "npm test",
        cwd: "/workspace",
      }),
      expect.objectContaining({ command: "npm test", itemId: "tool-string-3" }),
      expect.objectContaining({ grantRoot: "/workspace", reason: "Apply changes" }),
      expect.objectContaining({
        cwd: "/workspace",
        environmentId: "sandbox-1",
        permissions: { fileSystem: { read: ["/workspace"] }, network: null },
      }),
    ]);
    expect(permissionInputs.map(({ title }) => title)).toEqual([
      "Approve command execution",
      "Approve command execution",
      "Approve file changes",
      "Approve runtime permissions",
    ]);
    expect(permissionInputs.map(({ requestId }) => requestId)).toEqual([
      "item/commandExecution/requestApproval:number:3",
      "item/commandExecution/requestApproval:string:3",
      "item/fileChange/requestApproval:number:4",
      "item/permissions/requestApproval:number:5",
    ]);
    expect(rejections.some((response) => response.id === 3)).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    await handler.abortAll(new Error("test complete"));
  }
});

test("OpenAI writeStdin approval uses terminal-input semantics", async () => {
  const permission = Promise.withResolvers<DriverPermissionRequest>();
  const response = Promise.withResolvers<unknown>();
  const context = createAgentDriverContext({
    eventSink: {
      currentRunId: () => null,
      pushEvents: async () => ({ accepted: [] }),
    },
    logger: createDisabledLogger(),
    payload: driverStartInput,
    permission: {
      request: async (input) => {
        permission.resolve(input);
        return "allow_once";
      },
    },
  });
  const handler = new OpenAiAppServerRequestHandler({
    context,
    handleError: async () => {},
    isStopped: () => false,
    mapToolCallId: (toolCallId) => toolCallId,
    respond: (_id, result) => response.resolve(result),
    respondError: (_id, message) => response.reject(new Error(message)),
  });

  handler.dispatch("item/commandExecution/requestApproval", 1, {
    approvalId: "approval-1",
    itemId: "command-1",
    kind: "writeStdin",
  });

  await expect(response.promise).resolves.toEqual({ decision: "accept" });
  expect(await permission.promise).toMatchObject({
    title: "Approve terminal input",
    toolCallId: "command-1",
  });
});

test("OpenAI server request cancellation propagates permission delivery failures", async () => {
  const permissionStarted = Promise.withResolvers<void>();
  const deliveryGate = Promise.withResolvers<void>();
  const deliveryError = new PermissionEventDeliveryError(
    "item/commandExecution/requestApproval:number:3",
    "resolved",
    new Error("event sink unavailable"),
  );
  const handledErrors: Error[] = [];
  const context = createAgentDriverContext({
    eventSink: {
      currentRunId: () => null,
      pushEvents: async () => ({ accepted: [] }),
    },
    logger: createDisabledLogger(),
    payload: driverStartInput,
    permission: {
      request: async (_input, signal) => {
        const requestSignal = signal ?? new AbortController().signal;
        permissionStarted.resolve();
        await new Promise<void>((resolve) => {
          if (requestSignal.aborted) {
            resolve();
            return;
          }
          requestSignal.addEventListener("abort", () => resolve(), { once: true });
        });
        await deliveryGate.promise;
        throw deliveryError;
      },
    },
  });
  const handler = new OpenAiAppServerRequestHandler({
    context,
    handleError: async (error) => {
      handledErrors.push(error);
    },
    isStopped: () => false,
    mapToolCallId: (toolCallId) => toolCallId,
    respond: () => {},
    respondError: () => {},
  });

  try {
    handler.dispatch("item/commandExecution/requestApproval", 3, {
      command: "pwd",
      itemId: "tool-1",
    });
    await permissionStarted.promise;
    const cancellation = handler.abortAll(new Error("turn cancelled"));
    void cancellation.catch(() => {});
    deliveryGate.resolve();

    await expect(cancellation).rejects.toBe(deliveryError);
    expect(handledErrors).toEqual([deliveryError]);
  } finally {
    deliveryGate.resolve();
    await handler.abortAll(new Error("test complete"));
  }
});
