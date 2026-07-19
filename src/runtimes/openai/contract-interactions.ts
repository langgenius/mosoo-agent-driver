import { interactionSchema } from "../../contract";
import type { Interaction, InteractionResolution, Item } from "../../contract";
import { asJsonValue } from "../contract-adapter-meta";
import { isRecord, readArray, readNonEmptyString, readString } from "./app-server-json";
import type { JsonObject, JsonRpcId } from "./app-server-json";
import {
  dynamicToolName,
  provenance,
  readFiniteNumber,
  requireRecord,
  toNativeToolContent,
} from "./contract-items";

export const OPENAI_APP_SERVER_MCP_ELICITATION_EXTENSION = "openai.app-server/mcp-elicitation";

export interface OpenAiInteractionTurn {
  readonly runId: string;
  readonly threadId: string;
  readonly turnId: string;
}

export interface PendingServerRequest {
  bytes: number;
  commit?: Promise<void> | undefined;
  interaction: Interaction;
  method: string;
  params: JsonObject;
  requestId: JsonRpcId;
  turnId: string;
}

export function toInputAnswer(params: JsonObject, questionId: string, answer: string): string {
  const question = readArray(params, "questions").find(
    (entry) => isRecord(entry) && readString(entry, "id") === questionId,
  );

  if (!isRecord(question)) {
    return answer;
  }

  for (const [index, option] of readArray(question, "options").entries()) {
    if (!isRecord(option)) {
      continue;
    }

    const label = readNonEmptyString(option, "label");

    if (label !== null && String(index) === answer) {
      return label;
    }
  }

  return answer;
}

export function selectedOption(
  interaction: Interaction,
  resolution: Extract<InteractionResolution, { kind: "permission" }>["value"],
): string | null {
  if (resolution.type === "cancelled") {
    return null;
  }

  if (
    interaction.kind !== "permission" ||
    !interaction.request.options.some((option) => option.id === resolution.optionId)
  ) {
    throw new Error("OpenAI permission resolution selected an unavailable option.");
  }

  return resolution.optionId;
}

export function projectOpenAiInteraction(
  method: string,
  requestId: JsonRpcId,
  params: JsonObject,
  turn: OpenAiInteractionTurn,
  options: {
    readonly createId: () => string;
    readonly interactionTimeoutMs: number;
    readonly item: (runId: string, itemId: string) => Item | undefined;
    readonly now: () => Date;
  },
): Interaction | null {
  const createdAt = options.now().toISOString();
  const itemId =
    readNonEmptyString(params, "itemId") ??
    (method === "item/tool/call" ? readNonEmptyString(params, "callId") : null);
  const knownItem =
    itemId !== null && options.item(turn.runId, itemId) !== undefined ? itemId : undefined;
  const requestedTimeoutMs = readFiniteNumber(params, "autoResolutionMs");
  const timeoutMs =
    requestedTimeoutMs !== null &&
    Number.isSafeInteger(requestedTimeoutMs) &&
    requestedTimeoutMs > 0
      ? Math.min(requestedTimeoutMs, options.interactionTimeoutMs)
      : options.interactionTimeoutMs;
  const common = {
    audience: "participants",
    blocking: true,
    createdAt,
    expiresAt: new Date(Date.parse(createdAt) + timeoutMs).toISOString(),
    id: options.createId(),
    ...(knownItem === undefined ? {} : { itemId: knownItem }),
    provenance: provenance(method, {
      ...(itemId === null ? {} : { itemId }),
      requestId: String(requestId),
      threadId: turn.threadId,
      turnId: turn.turnId,
    }),
    runId: turn.runId,
    status: "open",
  };

  if (
    method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval" ||
    method === "item/permissions/requestApproval"
  ) {
    const command = readNonEmptyString(params, "command");
    const reason = readString(params, "reason");
    const availableDecisions = params["availableDecisions"];
    const allowed =
      method === "item/commandExecution/requestApproval" && Array.isArray(availableDecisions)
        ? new Set(availableDecisions.filter((value) => typeof value === "string"))
        : null;
    const options = [
      {
        decision: "accept",
        effect: "allow",
        id: "accept_once",
        label: "Allow once",
        scope: "once",
      },
      {
        decision: "acceptForSession",
        effect: "allow",
        id: "accept_session",
        label: "Allow for session",
        scope: "session",
      },
      { decision: "decline", effect: "deny", id: "decline", label: "Decline", scope: "once" },
    ].flatMap(({ decision, ...option }) =>
      allowed === null || allowed.has(decision) ? [option] : [],
    );

    if (options.length === 0) {
      return null;
    }

    return interactionSchema.parse({
      ...common,
      kind: "permission",
      request: {
        ...(reason === null ? {} : { description: reason }),
        options,
        subject:
          knownItem === undefined
            ? {
                operation: method,
                targets: [itemId ?? command ?? method],
                type: "resource",
              }
            : { itemId: knownItem, type: "item" },
        title:
          method === "item/fileChange/requestApproval"
            ? "Approve file changes"
            : method === "item/permissions/requestApproval"
              ? "Approve runtime permissions"
              : "Approve command execution",
      },
    });
  }

  if (method === "item/tool/requestUserInput") {
    const questions = readArray(params, "questions").flatMap((entry) => {
      if (!isRecord(entry)) {
        return [];
      }

      const id = readNonEmptyString(entry, "id");
      const prompt = readNonEmptyString(entry, "question");

      if (id === null || prompt === null) {
        return [];
      }

      const nativeOptions = entry["options"];
      const mappedOptions = Array.isArray(nativeOptions)
        ? nativeOptions.flatMap((option, index) => {
            if (!isRecord(option)) {
              return [];
            }

            const label = readNonEmptyString(option, "label");
            const description = readString(option, "description");
            return label === null
              ? []
              : [
                  {
                    ...(description === null ? {} : { description }),
                    id: String(index),
                    label,
                  },
                ];
          })
        : [];
      const options = mappedOptions.length === 0 ? undefined : mappedOptions;

      return [
        {
          ...(options !== undefined && entry["isOther"] === true ? { allowOther: true } : {}),
          id,
          ...(options === undefined ? {} : { options }),
          prompt,
          required: true,
          type:
            options === undefined
              ? entry["isSecret"] === true
                ? "secret"
                : "text"
              : "single_select",
        },
      ];
    });

    return questions.length === 0
      ? null
      : interactionSchema.parse({
          ...common,
          kind: "input",
          request: { questions },
        });
  }

  if (method === "item/tool/call") {
    const tool = dynamicToolName(params);
    const input = asJsonValue(params["arguments"]);

    return tool === null
      ? null
      : interactionSchema.parse({
          ...common,
          kind: "tool",
          request: {
            ...(input === undefined ? {} : { input }),
            name: tool,
          },
        });
  }

  if (method === "mcpServer/elicitation/request") {
    const request = asJsonValue(params);

    return request === undefined
      ? null
      : interactionSchema.parse({
          ...common,
          kind: "extension",
          name: OPENAI_APP_SERVER_MCP_ELICITATION_EXTENSION,
          request,
        });
  }

  return null;
}

export function toOpenAiRequestResult(
  pending: PendingServerRequest,
  resolution: InteractionResolution,
): unknown {
  if (
    pending.method === "item/commandExecution/requestApproval" ||
    pending.method === "item/fileChange/requestApproval"
  ) {
    if (resolution.kind !== "permission") {
      throw new Error("OpenAI approval request requires a permission resolution.");
    }

    const optionId = selectedOption(pending.interaction, resolution.value);
    const decision =
      optionId === null
        ? "cancel"
        : optionId === "accept_once"
          ? "accept"
          : optionId === "accept_session"
            ? "acceptForSession"
            : optionId === "decline"
              ? "decline"
              : null;

    if (decision === null) {
      throw new Error("OpenAI approval resolution selected an unknown option.");
    }

    return { decision };
  }

  if (pending.method === "item/permissions/requestApproval") {
    if (resolution.kind !== "permission") {
      throw new Error("OpenAI permission profile request requires a permission resolution.");
    }

    const optionId = selectedOption(pending.interaction, resolution.value);
    const accepted = optionId === "accept_once" || optionId === "accept_session";

    if (
      optionId !== null &&
      optionId !== "accept_once" &&
      optionId !== "accept_session" &&
      optionId !== "decline"
    ) {
      throw new Error("OpenAI permission resolution selected an unknown option.");
    }

    return {
      permissions:
        accepted && isRecord(pending.params["permissions"]) ? pending.params["permissions"] : {},
      scope: optionId === "accept_session" ? "session" : "turn",
    };
  }

  if (pending.method === "item/tool/requestUserInput") {
    if (resolution.kind !== "input") {
      throw new Error("OpenAI user input request requires an input resolution.");
    }

    return {
      answers:
        resolution.value.type === "cancelled"
          ? {}
          : Object.fromEntries(
              Object.entries(resolution.value.answers).map(([id, answers]) => [
                id,
                {
                  answers: answers.map((answer) => toInputAnswer(pending.params, id, answer)),
                },
              ]),
            ),
    };
  }

  if (pending.method === "item/tool/call") {
    if (resolution.kind !== "tool") {
      throw new Error("OpenAI dynamic tool request requires a tool resolution.");
    }

    if (resolution.value.type === "completed") {
      const contentItems = resolution.value.output.flatMap(toNativeToolContent);

      if (resolution.value.structuredOutput !== undefined) {
        contentItems.push({
          text: JSON.stringify(resolution.value.structuredOutput),
          type: "inputText",
        });
      }

      return { contentItems, success: true };
    }

    const message =
      resolution.value.type === "failed" ? resolution.value.error.message : "Tool call cancelled.";
    return {
      contentItems: [{ text: message, type: "inputText" }],
      success: false,
    };
  }

  if (pending.method === "mcpServer/elicitation/request") {
    if (
      resolution.kind !== "extension" ||
      resolution.name !== OPENAI_APP_SERVER_MCP_ELICITATION_EXTENSION
    ) {
      throw new Error("OpenAI MCP elicitation requires its namespaced extension resolution.");
    }

    const value = requireRecord(resolution.value, "OpenAI MCP elicitation resolution");
    const action = readString(value, "action");

    if (action !== "accept" && action !== "decline" && action !== "cancel") {
      throw new Error("OpenAI MCP elicitation resolution has an unsupported action.");
    }

    return {
      _meta: asJsonValue(value["_meta"]) ?? null,
      action,
      content: asJsonValue(value["content"]) ?? null,
    };
  }

  throw new Error(`Unsupported OpenAI app-server request: ${pending.method}.`);
}
