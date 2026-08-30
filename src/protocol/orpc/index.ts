import { z } from "zod";

import {
  DURABLE_RUN_ERROR_MAX_UTF8_BYTES,
  DRIVER_CAPABILITY_IDS,
  RUNTIME_COMMAND_TERMINAL_PAYLOAD_MAX_UTF8_BYTES,
  measureRuntimeCommandJson,
  parseRuntimeCommand,
} from "../../runtime-command";
import { DRIVER_PROTOCOL_VERSION } from "../boot";
import { RUNTIME_EVENT_KINDS, parseDriverEventEnvelope } from "../events";
import { SUPPORTED_DRIVER_RUNTIMES } from "../runtime";

const nonEmptyStringSchema = z.string().min(1);
const lowercaseUuidV4Schema = z.uuidv4().regex(/^[0-9a-f-]+$/u, "UUID must be lowercase.");
const primitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const okSchema = z.strictObject({ ok: z.literal(true) });
const driverRpcBatchMaxSize = 64;

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function positiveSafeIntegerSchema(label: string, minimum = 1) {
  return z.number().refine((value) => Number.isSafeInteger(value) && value >= minimum, {
    error:
      minimum === 1
        ? `${label} must be a positive safe integer.`
        : `${label} must be an integer of at least ${String(minimum)}.`,
  });
}

function nonNegativeSafeIntegerSchema(label: string) {
  return z.number().refine((value) => Number.isSafeInteger(value) && value >= 0, {
    error: `${label} must be a non-negative safe integer.`,
  });
}

function parsedSchema<Output>(parser: (value: unknown) => Output) {
  return z.unknown().transform((value, ctx) => {
    try {
      return parser(value);
    } catch (error) {
      if (error instanceof z.ZodError) {
        for (const issue of error.issues) {
          ctx.addIssue({ code: "custom", message: issue.message, path: issue.path });
        }
      } else {
        ctx.addIssue({
          code: "custom",
          message: error instanceof Error ? error.message : "Invalid value.",
        });
      }

      return z.NEVER;
    }
  });
}

function primitiveRecordSchema(label: string) {
  return z
    .custom<Record<string, unknown>>(
      (value) => typeof value === "object" && value !== null && !Array.isArray(value),
      { error: `${label} must be an object.` },
    )
    .superRefine((record, ctx) => {
      for (const [field, value] of Object.entries(record)) {
        if (!primitiveSchema.safeParse(value).success) {
          ctx.addIssue({
            code: "custom",
            message: `${label}.${field} must be a primitive value.`,
            path: [field],
          });
        }
      }
    })
    .transform(
      (record) =>
        Object.fromEntries(Object.entries(record)) as Record<
          string,
          string | number | boolean | null
        >,
    );
}

const driverCapabilitySchema = z
  .strictObject({
    details: z.string().optional(),
    id: z.enum(DRIVER_CAPABILITY_IDS, { error: "capability id is unsupported." }),
    status: z.enum(["supported", "unsupported"], {
      error: "capability status must be supported or unsupported.",
    }),
    version: z.literal(1, { error: "capability version must be 1." }),
  })
  .transform(omitUndefined);

const driverCapabilitiesSchema = z
  .array(driverCapabilitySchema)
  .superRefine((capabilities, ctx) => {
    if (new Set(capabilities.map(({ id }) => id)).size !== capabilities.length) {
      ctx.addIssue({
        code: "custom",
        message: "capabilities must not contain duplicate ids.",
      });
    }
  });

const durableRunErrorSchema = z
  .strictObject({
    code: nonEmptyStringSchema,
    details: primitiveRecordSchema("driver failure details"),
    message: nonEmptyStringSchema,
    retryable: z.boolean(),
  })
  .refine((error) => measureRuntimeCommandJson(error) <= DURABLE_RUN_ERROR_MAX_UTF8_BYTES, {
    error: `Driver error must not exceed ${String(DURABLE_RUN_ERROR_MAX_UTF8_BYTES)} UTF-8 bytes.`,
  });

const inputStartCommandResultSchema = z.strictObject({
  requestId: nonEmptyStringSchema,
});

const mcpExecuteCommandResultSchema = z
  .strictObject({
    isError: z.boolean().optional(),
    outputText: z.string(),
    requestId: nonEmptyStringSchema,
    serverId: nonEmptyStringSchema,
    toolName: nonEmptyStringSchema,
  })
  .transform(omitUndefined)
  .refine(
    (result) =>
      measureRuntimeCommandJson(result) <= RUNTIME_COMMAND_TERMINAL_PAYLOAD_MAX_UTF8_BYTES,
    {
      error: `MCP command result must not exceed ${String(RUNTIME_COMMAND_TERMINAL_PAYLOAD_MAX_UTF8_BYTES)} UTF-8 bytes.`,
    },
  );

const runtimeCommandResultSchema = z
  .union([inputStartCommandResultSchema, mcpExecuteCommandResultSchema])
  .refine(
    (result) =>
      measureRuntimeCommandJson(result) <= RUNTIME_COMMAND_TERMINAL_PAYLOAD_MAX_UTF8_BYTES,
    {
      error: `Driver command result must not exceed ${String(RUNTIME_COMMAND_TERMINAL_PAYLOAD_MAX_UTF8_BYTES)} UTF-8 bytes.`,
    },
  );

const driverHelloInputSchema = z.strictObject({
  capabilities: driverCapabilitiesSchema,
  driverVersion: nonEmptyStringSchema,
  pid: positiveSafeIntegerSchema("pid"),
  protocolVersion: z.literal(DRIVER_PROTOCOL_VERSION, {
    error: `protocolVersion must be ${String(DRIVER_PROTOCOL_VERSION)}.`,
  }),
  runtime: z.enum(SUPPORTED_DRIVER_RUNTIMES, { error: "Unsupported driver runtime." }),
  startedAt: nonEmptyStringSchema,
});

const driverHelloOutputSchema = z.strictObject({
  acceptedCapabilities: driverCapabilitiesSchema,
  connectionId: nonEmptyStringSchema,
  driverInstanceId: nonEmptyStringSchema,
  heartbeatIntervalMs: positiveSafeIntegerSchema("Driver heartbeat interval", 250),
  runConfig: z.strictObject({
    commandLeaseMs: nonNegativeSafeIntegerSchema("Driver command lease"),
    envPolicy: z.literal("strict"),
    eventBatchMaxSize: positiveSafeIntegerSchema("Driver event batch max size").refine(
      (value) => value <= driverRpcBatchMaxSize,
      {
        error: `Driver event batch max size must not exceed ${String(driverRpcBatchMaxSize)}.`,
      },
    ),
    organizationPath: nonEmptyStringSchema,
  }),
  runId: nonEmptyStringSchema.nullable(),
});

const driverHeartbeatInputSchema = z.strictObject({
  at: nonEmptyStringSchema,
  pid: positiveSafeIntegerSchema("pid"),
  reason: z.enum(["interval", "ping"], { error: "reason must be interval or ping." }),
});

const driverHeartbeatOutputSchema = z.strictObject({
  heartbeatCount: nonNegativeSafeIntegerSchema("heartbeatCount"),
  ok: z.literal(true),
});

const driverReadyInputSchema = z.strictObject({
  at: nonEmptyStringSchema,
  driverInstanceId: nonEmptyStringSchema,
  pid: positiveSafeIntegerSchema("pid"),
});

const driverLogContextSchema = z
  .strictObject({
    parentSpanId: z.string().optional(),
    requestId: z.string().optional(),
    sandboxId: z.string().optional(),
    sessionId: z.string().optional(),
    spanId: z.string().optional(),
    traceId: z.string().optional(),
  })
  .transform(omitUndefined);

const driverLogErrorSchema = z
  .strictObject({
    code: z.union([z.string(), z.number()]).optional(),
    message: z.string(),
    name: z.string(),
    stack: z.string().nullable().optional(),
  })
  .transform(omitUndefined);

const driverLogEntrySchema = z
  .strictObject({
    context: driverLogContextSchema.optional(),
    error: driverLogErrorSchema.optional(),
    fields: primitiveRecordSchema("driver log fields").optional(),
    level: z.enum(["debug", "error", "info", "trace", "warn"], {
      error: "driver log level is unsupported.",
    }),
    message: z.string(),
    namespace: z.string().nullable().optional(),
    seq: nonNegativeSafeIntegerSchema("seq"),
    timestamp: nonEmptyStringSchema,
  })
  .transform(omitUndefined);

const driverLogBatchInputSchema = z.strictObject({
  driverInstanceId: nonEmptyStringSchema,
  logs: z.array(driverLogEntrySchema).max(driverRpcBatchMaxSize),
});

const driverFailureInputSchema = z.strictObject({
  driverInstanceId: nonEmptyStringSchema,
  error: durableRunErrorSchema,
  runId: nonEmptyStringSchema,
});

const driverCommandUpdateIdentitySchema = {
  commandId: nonEmptyStringSchema,
  driverInstanceId: nonEmptyStringSchema,
} as const;
const driverCommandUpdateInputSchema = z.discriminatedUnion("status", [
  z.strictObject({ ...driverCommandUpdateIdentitySchema, status: z.literal("accepted") }),
  z.strictObject({ ...driverCommandUpdateIdentitySchema, status: z.literal("cancelled") }),
  z.strictObject({
    ...driverCommandUpdateIdentitySchema,
    result: runtimeCommandResultSchema.optional(),
    status: z.literal("completed"),
  }),
  z.strictObject({
    ...driverCommandUpdateIdentitySchema,
    error: durableRunErrorSchema,
    status: z.literal("failed"),
  }),
]);

const driverExternalToolEffectObserveInputSchema = z.strictObject({
  commandId: nonEmptyStringSchema,
  driverInstanceId: nonEmptyStringSchema,
});

const driverExternalToolEffectIntentSchema = z.strictObject({
  effectId: nonEmptyStringSchema,
  kind: z.literal("intent"),
});

const driverExternalToolEffectClaimedSchema = z.strictObject({
  attempt: positiveSafeIntegerSchema("attempt"),
  effectId: nonEmptyStringSchema,
  idempotencyKey: nonEmptyStringSchema,
  kind: z.literal("claimed"),
});

const driverExternalToolEffectSucceededSchema = z.strictObject({
  effectId: nonEmptyStringSchema,
  kind: z.literal("succeeded"),
  result: mcpExecuteCommandResultSchema,
});

const driverExternalToolEffectUnknownSchema = z.strictObject({
  effectId: nonEmptyStringSchema,
  kind: z.literal("unknown"),
});

const driverExternalToolEffectStateSchema = z.discriminatedUnion("kind", [
  driverExternalToolEffectIntentSchema,
  driverExternalToolEffectClaimedSchema,
  driverExternalToolEffectSucceededSchema,
  driverExternalToolEffectUnknownSchema,
]);

const driverExternalToolEffectClaimInputSchema = z.strictObject({
  claimToken: lowercaseUuidV4Schema,
  commandId: nonEmptyStringSchema,
  driverInstanceId: nonEmptyStringSchema,
});

const driverExternalToolEffectClaimOutputSchema = z.discriminatedUnion("kind", [
  driverExternalToolEffectClaimedSchema,
  driverExternalToolEffectSucceededSchema,
  driverExternalToolEffectUnknownSchema,
]);

const driverExternalToolEffectSettlementSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("succeeded"),
      providerReceiptJson: z.string().nullable().optional(),
      result: mcpExecuteCommandResultSchema,
    }),
    z.strictObject({ kind: z.literal("unknown") }),
  ])
  .refine(
    (settlement) =>
      measureRuntimeCommandJson(settlement) <= RUNTIME_COMMAND_TERMINAL_PAYLOAD_MAX_UTF8_BYTES,
    {
      error: `MCP settlement must not exceed ${String(RUNTIME_COMMAND_TERMINAL_PAYLOAD_MAX_UTF8_BYTES)} UTF-8 bytes.`,
    },
  );

const driverExternalToolEffectSettleInputSchema = z.strictObject({
  claimToken: lowercaseUuidV4Schema,
  commandId: nonEmptyStringSchema,
  driverInstanceId: nonEmptyStringSchema,
  effectId: nonEmptyStringSchema,
  settlement: driverExternalToolEffectSettlementSchema,
});

const driverEventBatchInputSchema = z.strictObject({
  driverInstanceId: nonEmptyStringSchema,
  events: z.array(parsedSchema(parseDriverEventEnvelope)).max(driverRpcBatchMaxSize),
});

const driverEventReceiptSchema = z
  .strictObject({
    eventId: nonEmptyStringSchema,
    seq: nonNegativeSafeIntegerSchema("Driver event receipt seq"),
    type: z.enum(RUNTIME_EVENT_KINDS),
  })
  .transform(omitUndefined);

const driverEventBatchOutputSchema = z.strictObject({
  accepted: z.array(driverEventReceiptSchema),
});

const driverInstanceInputSchema = z.strictObject({
  driverInstanceId: nonEmptyStringSchema,
});

const driverCompletionInputSchema = z.strictObject({
  driverInstanceId: nonEmptyStringSchema,
  runId: nonEmptyStringSchema,
});

const driverNextCommandOutputSchema = z.strictObject({
  command: parsedSchema(parseRuntimeCommand).nullable(),
});

interface RpcMethodSchema {
  readonly input: z.ZodType;
  readonly output: z.ZodType;
}

type RpcSchemaMap = Record<string, Record<string, RpcMethodSchema>>;

type DeepReadonly<Value> = Value extends
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  ? Value
  : Value extends readonly (infer Entry)[]
    ? readonly DeepReadonly<Entry>[]
    : Value extends object
      ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
      : Value;

type SchemaValue<Schema extends z.ZodType> = DeepReadonly<z.output<Schema>>;

export const driverRuntimeRpcSchemas = {
  driver: {
    observeExternalToolEffect: {
      input: driverExternalToolEffectObserveInputSchema,
      output: driverExternalToolEffectStateSchema,
    },
    claimExternalToolEffect: {
      input: driverExternalToolEffectClaimInputSchema,
      output: driverExternalToolEffectClaimOutputSchema,
    },
    commandUpdate: { input: driverCommandUpdateInputSchema, output: okSchema },
    completeRun: { input: driverCompletionInputSchema, output: okSchema },
    failRun: { input: driverFailureInputSchema, output: okSchema },
    heartbeat: { input: driverHeartbeatInputSchema, output: driverHeartbeatOutputSchema },
    hello: { input: driverHelloInputSchema, output: driverHelloOutputSchema },
    settleExternalToolEffect: {
      input: driverExternalToolEffectSettleInputSchema,
      output: driverExternalToolEffectStateSchema,
    },
    pushEvents: { input: driverEventBatchInputSchema, output: driverEventBatchOutputSchema },
    pushLogs: { input: driverLogBatchInputSchema, output: okSchema },
    ready: { input: driverReadyInputSchema, output: okSchema },
  },
  driverInstance: {
    nextCommand: { input: driverInstanceInputSchema, output: driverNextCommandOutputSchema },
  },
} as const satisfies RpcSchemaMap;

export interface DriverRpcOptions {
  readonly signal?: AbortSignal;
}

type RpcClient<Schema extends RpcSchemaMap> = {
  readonly [Group in keyof Schema]: {
    readonly [Method in keyof Schema[Group]]: Schema[Group][Method] extends RpcMethodSchema
      ? (
          input: SchemaValue<Schema[Group][Method]["input"]>,
          options?: DriverRpcOptions,
        ) => Promise<SchemaValue<Schema[Group][Method]["output"]>>
      : never;
  };
};

export type DriverRuntimeClient = RpcClient<typeof driverRuntimeRpcSchemas>;
export type DriverHelloInput = SchemaValue<typeof driverHelloInputSchema>;
export type DriverHelloOutput = SchemaValue<typeof driverHelloOutputSchema>;
export type DriverHeartbeatInput = SchemaValue<typeof driverHeartbeatInputSchema>;
export type DriverHeartbeatOutput = SchemaValue<typeof driverHeartbeatOutputSchema>;
export type DriverReadyInput = SchemaValue<typeof driverReadyInputSchema>;
export type DriverLogContext = z.output<typeof driverLogContextSchema>;
export type DriverLogError = SchemaValue<typeof driverLogErrorSchema>;
export type DriverLogEntry = Omit<SchemaValue<typeof driverLogEntrySchema>, "context"> & {
  readonly context?: DriverLogContext | undefined;
};
export type DriverLogBatchInput = Omit<SchemaValue<typeof driverLogBatchInputSchema>, "logs"> & {
  readonly logs: readonly DriverLogEntry[];
};
export type DriverLogBatchOutput = SchemaValue<typeof okSchema>;
export type DriverFailureInput = SchemaValue<typeof driverFailureInputSchema>;
export type DriverCommandUpdateInput = SchemaValue<typeof driverCommandUpdateInputSchema>;
export type DriverExternalToolEffectObserveInput = SchemaValue<
  typeof driverExternalToolEffectObserveInputSchema
>;
export type DriverExternalToolEffectState = SchemaValue<typeof driverExternalToolEffectStateSchema>;
export type DriverExternalToolEffectClaimInput = SchemaValue<
  typeof driverExternalToolEffectClaimInputSchema
>;
export type DriverExternalToolEffectClaimOutput = SchemaValue<
  typeof driverExternalToolEffectClaimOutputSchema
>;
export type DriverExternalToolEffectSettleInput = SchemaValue<
  typeof driverExternalToolEffectSettleInputSchema
>;
export type DriverEventBatchInput = SchemaValue<typeof driverEventBatchInputSchema>;
export type DriverEventReceipt = SchemaValue<typeof driverEventReceiptSchema>;
export type DriverEventBatchOutput = SchemaValue<typeof driverEventBatchOutputSchema>;
export type DriverNextCommandInput = SchemaValue<typeof driverInstanceInputSchema>;
export type DriverNextCommandOutput = SchemaValue<typeof driverNextCommandOutputSchema>;
export type DriverCompletionInput = SchemaValue<typeof driverCompletionInputSchema>;

export function parseDriverHelloInput(value: unknown): DriverHelloInput {
  return driverHelloInputSchema.parse(value);
}

export function parseDriverHeartbeatInput(value: unknown): DriverHeartbeatInput {
  return driverHeartbeatInputSchema.parse(value);
}

export function parseDriverReadyInput(value: unknown): DriverReadyInput {
  return driverReadyInputSchema.parse(value);
}

export function parseDriverCommandUpdateInput(value: unknown): DriverCommandUpdateInput {
  return driverCommandUpdateInputSchema.parse(value);
}

export function parseDriverExternalToolEffectObserveInput(
  value: unknown,
): DriverExternalToolEffectObserveInput {
  return driverExternalToolEffectObserveInputSchema.parse(value);
}

export function parseDriverExternalToolEffectClaimInput(
  value: unknown,
): DriverExternalToolEffectClaimInput {
  return driverExternalToolEffectClaimInputSchema.parse(value);
}

export function parseDriverExternalToolEffectSettleInput(
  value: unknown,
): DriverExternalToolEffectSettleInput {
  return driverExternalToolEffectSettleInputSchema.parse(value);
}

export function parseDriverCompletionInput(value: unknown): DriverCompletionInput {
  return driverCompletionInputSchema.parse(value);
}

export function parseDriverFailureInput(value: unknown): DriverFailureInput {
  return driverFailureInputSchema.parse(value);
}

export function parseDriverLogBatchInput(value: unknown): DriverLogBatchInput {
  return driverLogBatchInputSchema.parse(value);
}

export function parseDriverEventBatchInput(value: unknown): DriverEventBatchInput {
  return driverEventBatchInputSchema.parse(value);
}

export function parseDriverNextCommandInput(value: unknown): DriverNextCommandInput {
  return driverInstanceInputSchema.parse(value);
}
