import { z } from "zod";

import type { DriverId, RunId, SessionId } from "../id";
import { DRIVER_ID_INPUT_PATTERN, normalizeDriverId } from "../id";
import type {
  AccountId,
  AgentDeploymentVersionId,
  AgentId,
  EnvironmentId,
  EnvironmentRevisionId,
  SandboxId,
  SandboxSessionId,
} from "./host-ids";

const driverIdInputPattern = new RegExp(DRIVER_ID_INPUT_PATTERN, "u");
const nonEmptyStringSchema = z.string().min(1);

export function ownObjectSchema<const Shape extends z.ZodRawShape>(shape: Shape) {
  const keys = Object.keys(shape);
  return z.preprocess(
    (value) =>
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
            keys.flatMap((key) =>
              Object.hasOwn(value, key) ? [[key, (value as Record<string, unknown>)[key]]] : [],
            ),
          )
        : value,
    z.object(shape),
  );
}

export function ownArraySchema<Element extends z.ZodType>(element: Element) {
  return z.preprocess((value) => {
    if (!Array.isArray(value)) {
      return value;
    }

    const copy = Array.from<unknown>({ length: value.length });
    for (let index = 0; index < value.length; index += 1) {
      copy[index] = Object.hasOwn(value, index) ? value[index] : undefined;
    }
    return copy;
  }, z.array(element));
}

export function createDriverIdSchema<Id extends DriverId>() {
  return z
    .string()
    .regex(driverIdInputPattern, "must be a valid ULID")
    .transform((value) => normalizeDriverId(value) as Id);
}

export const driverOriginSchema = ownObjectSchema({
  callerUserId: createDriverIdSchema<AccountId>(),
  entrypoint: z.enum(["api", "chat"]),
  executionOwnerUserId: createDriverIdSchema<AccountId>(),
  type: z.literal("agent"),
});

export type DriverOrigin = z.infer<typeof driverOriginSchema>;

export const driverExecutionSessionContextSchema = ownObjectSchema({
  homePath: nonEmptyStringSchema,
  origin: driverOriginSchema,
  sandboxId: createDriverIdSchema<SandboxId>(),
  sandboxKind: nonEmptyStringSchema,
  sandboxSessionId: createDriverIdSchema<SandboxSessionId>(),
  sandboxSubjectId: createDriverIdSchema<DriverId>(),
  sandboxSubjectKind: nonEmptyStringSchema,
  sessionOrganizationPath: nonEmptyStringSchema,
});

export type DriverExecutionSessionContext = z.infer<typeof driverExecutionSessionContextSchema>;

export const driverConfigRevisionSchema = ownObjectSchema({
  agentId: createDriverIdSchema<AgentId>(),
  deploymentVersionId: createDriverIdSchema<AgentDeploymentVersionId>().nullable(),
  deploymentVersionNumber: z.number().finite().nullable(),
  environmentId: createDriverIdSchema<EnvironmentId>(),
  environmentRevisionId: createDriverIdSchema<EnvironmentRevisionId>(),
  runId: createDriverIdSchema<RunId>().nullable(),
  sessionId: createDriverIdSchema<SessionId>(),
});

export type DriverConfigRevision = z.infer<typeof driverConfigRevisionSchema>;
