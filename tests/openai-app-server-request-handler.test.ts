import { expect, test } from "bun:test";

import { createAgentDriverContext } from "../src/core/agent-driver-backend";
import { PermissionEventDeliveryError } from "../src/core/driver-permission-broker";
import { createBufferedSinkLogger } from "../src/observability";
import { OpenAiAppServerRequestHandler } from "../src/runtimes/openai/app-server-request-handler";
import { driverStartInput } from "./driver-boot-payload-fixture";

test("OpenAI server request callbacks handle, reject, and cancel explicitly", async () => {
  const permissionStarted = Promise.withResolvers<void>();
  let permissionSignal: AbortSignal | null = null;
  const responses: Array<{ id: string | number; result: unknown }> = [];
  const rejections: Array<{ id: string | number; message: string }> = [];
  const errors: Error[] = [];
  const logger = createBufferedSinkLogger({
    level: "error",
    service: "openai-request-handler-test",
    sink: async () => {},
  });
  const context = createAgentDriverContext({
    eventSink: { pushEvents: async () => ({ accepted: [] }) },
    logger,
    payload: driverStartInput,
    permission: {
      request: async (_input, signal) => {
        const requestSignal = signal ?? new AbortController().signal;
        permissionSignal = requestSignal;
        permissionStarted.resolve();
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
    respond: (id, result) => responses.push({ id, result }),
    respondError: (id, message) => rejections.push({ id, message }),
  });

  try {
    handler.dispatch("currentTime/read", 1, {});
    handler.dispatch("attestation/generate", 2, {});
    handler.dispatch("item/commandExecution/requestApproval", 3, {
      command: "pwd",
      itemId: "tool-1",
    });
    await permissionStarted.promise;
    await handler.abortAll(new Error("turn cancelled"));

    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ id: 1, result: { currentTimeAt: expect.any(Number) } });
    expect(rejections).toEqual([
      { id: 2, message: "Unsupported OpenAi app-server request: attestation/generate." },
    ]);
    expect((permissionSignal as AbortSignal | null)?.aborted).toBe(true);
    expect(responses.some((response) => response.id === 3)).toBe(false);
    expect(rejections.some((response) => response.id === 3)).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    await handler.abortAll(new Error("test complete"));
    await logger.destroy();
  }
});

test("OpenAI server request cancellation propagates permission delivery failures", async () => {
  const permissionStarted = Promise.withResolvers<void>();
  const deliveryGate = Promise.withResolvers<void>();
  const deliveryError = new PermissionEventDeliveryError(
    "item/commandExecution/requestApproval:3",
    "resolved",
    new Error("event sink unavailable"),
  );
  const handledErrors: Error[] = [];
  const logger = createBufferedSinkLogger({
    level: "error",
    service: "openai-request-handler-test",
    sink: async () => {},
  });
  const context = createAgentDriverContext({
    eventSink: { pushEvents: async () => ({ accepted: [] }) },
    logger,
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
    await logger.destroy();
  }
});
