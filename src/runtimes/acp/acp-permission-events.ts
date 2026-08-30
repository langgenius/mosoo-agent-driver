import type { DriverEventInput } from "../../protocol/events";
import type { RunId } from "../../protocol/id";
import type { DriverPermissionRequest } from "../../host-ports";
import { toRuntimeToolStatus, toToolCallPayload } from "./acp-tool-events";
import {
  isRecord,
  readNonEmptyString,
  readRecord,
  readString,
  stringifyForDisplay,
} from "./acp-types";
import type { JsonObject } from "./acp-types";

export interface AcpPermissionTranslation {
  readonly events: DriverEventInput[];
  readonly options: readonly AcpPermissionOption[];
  readonly request: DriverPermissionRequest;
  readonly targetItemId: string;
  readonly toolCall: JsonObject | null;
}

export interface AcpPermissionOption {
  readonly kind: string;
  readonly name: string;
  readonly optionId: string;
}

export function toPermissionRequest(input: {
  params: unknown;
  requestId: string;
  runId: RunId | null;
}): AcpPermissionTranslation {
  const params = isRecord(input.params) ? input.params : {};
  const toolCall = readRecord(params, "toolCall");
  const options = normalizePermissionOptions(params["options"]);
  const nativeToolCallId = readNonEmptyString(toolCall, "toolCallId");
  const toolCallId = nativeToolCallId ?? input.requestId;
  const title =
    readNonEmptyString(toolCall, "title") ??
    readNonEmptyString(toolCall, "kind") ??
    "Allow tool call?";
  const events: DriverEventInput[] = [];

  if (toolCall !== null) {
    events.push({
      kind: "tool.call.updated",
      payload: toToolCallPayload(
        toolCallId,
        toRuntimeToolStatus(readString(toolCall, "status")),
        toolCall,
      ),
      ...(input.runId === null ? {} : { runId: input.runId }),
    });
  }

  return {
    events,
    options,
    request: {
      rawInput: stringifyForDisplay(toolCall?.["rawInput"]),
      requestId: input.requestId,
      title,
      toolCallId,
      toolKind: readNonEmptyString(toolCall, "kind"),
    },
    targetItemId: toolCallId,
    toolCall,
  };
}

function normalizePermissionOptions(raw: unknown): AcpPermissionOption[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.flatMap((entry): AcpPermissionOption[] => {
    if (!isRecord(entry)) {
      return [];
    }

    const optionId = readNonEmptyString(entry, "optionId");
    const name = readNonEmptyString(entry, "name");
    const kind = readNonEmptyString(entry, "kind");

    if (optionId === null || name === null || kind === null) {
      return [];
    }

    return [{ kind, name, optionId }];
  });
}
