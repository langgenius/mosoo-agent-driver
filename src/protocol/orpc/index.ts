import { z } from "zod";

import {
  DRIVER_CAPABILITY_IDS,
  parseRuntimeCommand,
  RUNTIME_COMMAND_STATUSES,
} from "../../runtime-command";
import { DRIVER_PROTOCOL_VERSION } from "../boot";
import { parseDriverEventEnvelope } from "../events";
import { SUPPORTED_DRIVER_RUNTIMES } from "../runtime";

const nonEmptyStringSchema = z.string().min(1);
const primitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const okSchema = z.object({ ok: z.literal(true) });

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
  .object({
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

const runErrorSchema = z.object({
  code: nonEmptyStringSchema,
  details: primitiveRecordSchema("driver failure details"),
  message: z.string(),
  retryable: z.boolean(),
});

const inputStartCommandResultSchema = z.object({
  requestId: nonEmptyStringSchema,
});

const mcpExecuteCommandResultSchema = z
  .object({
    isError: z.boolean().optional(),
    outputText: z.string(),
    requestId: nonEmptyStringSchema,
    serverId: nonEmptyStringSchema,
    toolName: nonEmptyStringSchema,
  })
  .transform(omitUndefined);

const runtimeCommandResultSchema = z.unknown().transform((value, ctx) => {
  if (value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const result = (
    record !== null &&
    typeof record === "object" &&
    !Array.isArray(record) &&
    ["isError", "outputText", "serverId", "toolName"].some((field) => Object.hasOwn(record, field))
      ? mcpExecuteCommandResultSchema
      : inputStartCommandResultSchema
  ).safeParse(value);

  if (result.success) {
    return result.data;
  }

  for (const issue of result.error.issues) {
    ctx.addIssue({ code: "custom", message: issue.message, path: issue.path });
  }
  return z.NEVER;
});

const driverHelloInputSchema = z.object({
  capabilities: driverCapabilitiesSchema,
  driverVersion: nonEmptyStringSchema,
  pid: positiveSafeIntegerSchema("pid"),
  protocolVersion: z.literal(DRIVER_PROTOCOL_VERSION, {
    error: `protocolVersion must be ${String(DRIVER_PROTOCOL_VERSION)}.`,
  }),
  runtime: z.enum(SUPPORTED_DRIVER_RUNTIMES, { error: "Unsupported driver runtime." }),
  startedAt: nonEmptyStringSchema,
});

const driverHelloOutputSchema = z.object({
  acceptedCapabilities: driverCapabilitiesSchema,
  connectionId: nonEmptyStringSchema,
  driverInstanceId: nonEmptyStringSchema,
  heartbeatIntervalMs: positiveSafeIntegerSchema("Driver heartbeat interval", 250),
  runConfig: z.object({
    commandLeaseMs: z.number().nonnegative(),
    envPolicy: z.literal("strict"),
    eventBatchMaxSize: positiveSafeIntegerSchema("Driver event batch max size"),
    organizationPath: nonEmptyStringSchema,
  }),
  runId: nonEmptyStringSchema.nullable(),
});

const driverHeartbeatInputSchema = z.object({
  at: nonEmptyStringSchema,
  pid: positiveSafeIntegerSchema("pid"),
  reason: z.enum(["interval", "ping"], { error: "reason must be interval or ping." }),
});

const driverHeartbeatOutputSchema = z.object({
  heartbeatCount: nonNegativeSafeIntegerSchema("heartbeatCount"),
  ok: z.literal(true),
});

const driverReadyInputSchema = z.object({
  at: nonEmptyStringSchema,
  driverInstanceId: nonEmptyStringSchema,
  pid: positiveSafeIntegerSchema("pid"),
});

const driverLogContextSchema = z
  .object({
    parentSpanId: z.string().optional(),
    requestId: z.string().optional(),
    sandboxId: z.string().optional(),
    sessionId: z.string().optional(),
    spanId: z.string().optional(),
    traceId: z.string().optional(),
  })
  .transform(omitUndefined);

const driverLogErrorSchema = z
  .object({
    code: z.union([z.string(), z.number()]).optional(),
    message: z.string(),
    name: z.string(),
    stack: z.string().nullable().optional(),
  })
  .transform(omitUndefined);

const driverLogEntrySchema = z
  .object({
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

const driverLogBatchInputSchema = z.object({
  driverInstanceId: nonEmptyStringSchema,
  logs: z.array(driverLogEntrySchema),
});

const driverFailureInputSchema = z.object({
  driverInstanceId: nonEmptyStringSchema,
  error: runErrorSchema,
});

const driverCommandUpdateInputSchema = z
  .object({
    commandId: nonEmptyStringSchema,
    driverInstanceId: nonEmptyStringSchema,
    error: runErrorSchema.optional(),
    result: runtimeCommandResultSchema.optional(),
    status: z.enum(RUNTIME_COMMAND_STATUSES, {
      error: "status is not a supported runtime command status.",
    }),
  })
  .transform(omitUndefined);

const driverExternalToolEffectClaimInputSchema = z.object({
  commandId: nonEmptyStringSchema,
  driverInstanceId: nonEmptyStringSchema,
});

const driverExternalToolEffectClaimOutputSchema = z.discriminatedUnion("kind", [
  z.object({
    attempt: positiveSafeIntegerSchema("attempt"),
    effectId: nonEmptyStringSchema,
    idempotencyKey: nonEmptyStringSchema,
    kind: z.literal("execute"),
  }),
  z.object({
    effectId: nonEmptyStringSchema,
    kind: z.literal("completed"),
    result: mcpExecuteCommandResultSchema,
  }),
  z.object({
    effectId: nonEmptyStringSchema,
    kind: z.literal("unknown"),
  }),
]);

const driverExternalToolEffectCompleteInputSchema = z
  .object({
    commandId: nonEmptyStringSchema,
    driverInstanceId: nonEmptyStringSchema,
    providerReceiptJson: z.string().nullable().optional(),
    result: mcpExecuteCommandResultSchema,
  })
  .transform(omitUndefined);

const driverExternalToolEffectUnknownInputSchema = z.object({
  commandId: nonEmptyStringSchema,
  driverInstanceId: nonEmptyStringSchema,
});

const driverEventBatchInputSchema = z.object({
  driverInstanceId: nonEmptyStringSchema,
  events: z.array(parsedSchema(parseDriverEventEnvelope)),
});

const driverEventReceiptSchema = z
  .object({
    eventId: z.string().optional(),
    seq: nonNegativeSafeIntegerSchema("Driver event receipt seq"),
    type: z.string(),
  })
  .transform(omitUndefined);

const driverEventBatchOutputSchema = z.object({
  accepted: z.array(driverEventReceiptSchema),
});

const driverInstanceInputSchema = z.object({
  driverInstanceId: nonEmptyStringSchema,
});

const driverNextCommandOutputSchema = z.object({
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
    claimExternalToolEffect: {
      input: driverExternalToolEffectClaimInputSchema,
      output: driverExternalToolEffectClaimOutputSchema,
    },
    commandUpdate: { input: driverCommandUpdateInputSchema, output: okSchema },
    completeExternalToolEffect: {
      input: driverExternalToolEffectCompleteInputSchema,
      output: okSchema,
    },
    completeRun: { input: driverInstanceInputSchema, output: okSchema },
    failRun: { input: driverFailureInputSchema, output: okSchema },
    heartbeat: { input: driverHeartbeatInputSchema, output: driverHeartbeatOutputSchema },
    hello: { input: driverHelloInputSchema, output: driverHelloOutputSchema },
    markExternalToolEffectUnknown: {
      input: driverExternalToolEffectUnknownInputSchema,
      output: okSchema,
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
export type DriverExternalToolEffectClaimInput = SchemaValue<
  typeof driverExternalToolEffectClaimInputSchema
>;
export type DriverExternalToolEffectClaimOutput = SchemaValue<
  typeof driverExternalToolEffectClaimOutputSchema
>;
export type DriverExternalToolEffectCompleteInput = SchemaValue<
  typeof driverExternalToolEffectCompleteInputSchema
>;
export type DriverExternalToolEffectUnknownInput = SchemaValue<
  typeof driverExternalToolEffectUnknownInputSchema
>;
export type DriverEventBatchInput = SchemaValue<typeof driverEventBatchInputSchema>;
export type DriverEventReceipt = SchemaValue<typeof driverEventReceiptSchema>;
export type DriverEventBatchOutput = SchemaValue<typeof driverEventBatchOutputSchema>;
export type DriverNextCommandInput = SchemaValue<typeof driverInstanceInputSchema>;
export type DriverNextCommandOutput = SchemaValue<typeof driverNextCommandOutputSchema>;
export type DriverCompletionInput = SchemaValue<typeof driverInstanceInputSchema>;

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

export function parseDriverExternalToolEffectClaimInput(
  value: unknown,
): DriverExternalToolEffectClaimInput {
  return driverExternalToolEffectClaimInputSchema.parse(value);
}

export function parseDriverExternalToolEffectCompleteInput(
  value: unknown,
): DriverExternalToolEffectCompleteInput {
  return driverExternalToolEffectCompleteInputSchema.parse(value);
}

export function parseDriverExternalToolEffectUnknownInput(
  value: unknown,
): DriverExternalToolEffectUnknownInput {
  return driverExternalToolEffectUnknownInputSchema.parse(value);
}

export function parseDriverCompletionInput(value: unknown): DriverCompletionInput {
  return driverInstanceInputSchema.parse(value);
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
