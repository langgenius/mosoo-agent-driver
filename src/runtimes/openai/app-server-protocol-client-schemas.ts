import { z } from "zod";

import initializeResponseJsonSchema from "./generated-json-schema/InitializeResponse.json" with { type: "json" };
import threadBackgroundTerminalsCleanResponseJsonSchema from "./generated-json-schema/ThreadBackgroundTerminalsCleanResponse.json" with { type: "json" };
import threadInjectItemsResponseJsonSchema from "./generated-json-schema/ThreadInjectItemsResponse.json" with { type: "json" };
import threadResumeResponseJsonSchema from "./generated-json-schema/ThreadResumeResponse.json" with { type: "json" };
import threadStartResponseJsonSchema from "./generated-json-schema/ThreadStartResponse.json" with { type: "json" };
import turnStartResponseJsonSchema from "./generated-json-schema/TurnStartResponse.json" with { type: "json" };
import type {
  InitializeResponse,
  ThreadBackgroundTerminalsCleanResponse,
  ThreadInjectItemsResponse,
  ThreadResumeResponse,
  ThreadStartResponse,
  TurnStartResponse,
} from "./app-server-protocol-types";
import { validateTurnStatusError } from "./app-server-turn-validation";

function fromGeneratedJsonSchema<Output>(schema: unknown): z.ZodType<Output> {
  return z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]) as z.ZodType<Output>;
}

const requestIdSchema = z.union([z.string(), z.number().int().safe()]);

export const jsonRpcResponseSchema = z.union([
  z.strictObject({
    id: requestIdSchema,
    result: z.json(),
  }),
  z.strictObject({
    error: z.strictObject({
      code: z.number().int().safe(),
      data: z.json().optional(),
      message: z.string(),
    }),
    id: requestIdSchema,
  }),
]);

export const initializeResponseSchema = fromGeneratedJsonSchema<InitializeResponse>(
  initializeResponseJsonSchema,
);
export const threadBackgroundTerminalsCleanResponseSchema =
  fromGeneratedJsonSchema<ThreadBackgroundTerminalsCleanResponse>(
    threadBackgroundTerminalsCleanResponseJsonSchema,
  );
export const threadInjectItemsResponseSchema = fromGeneratedJsonSchema<ThreadInjectItemsResponse>(
  threadInjectItemsResponseJsonSchema,
);
export const threadResumeResponseSchema = fromGeneratedJsonSchema<ThreadResumeResponse>(
  threadResumeResponseJsonSchema,
);
export const threadStartResponseSchema = fromGeneratedJsonSchema<ThreadStartResponse>(
  threadStartResponseJsonSchema,
);
export const turnStartResponseSchema = fromGeneratedJsonSchema<TurnStartResponse>(
  turnStartResponseJsonSchema,
).superRefine((response, context) => {
  const message = validateTurnStatusError(response.turn, false);

  if (message !== null) {
    context.addIssue({
      code: "custom",
      input: response.turn,
      message,
      path: ["turn", "error"],
    });
  }
});
