import type { DriverEventInput } from "../../protocol/events";

export type CmaSessionStatus = "idle" | "rescheduling" | "running" | "terminated";

export interface CmaOutboundEvent {
  readonly error?: unknown;
  readonly message?: unknown;
  readonly metadata?: Record<string, unknown>;
  readonly requiresAction?: unknown;
  readonly sessionStatus?: CmaSessionStatus;
  readonly sourceEventKind: string;
  readonly type:
    | "agent.custom_tool_use"
    | "agent.mcp_tool_use"
    | "agent.message"
    | "agent.thinking"
    | "agent.tool_use"
    | "session.error"
    | "session.status_idle"
    | "session.status_rescheduling"
    | "session.status_running"
    | "session.status_terminated"
    | "session.usage";
  readonly usage?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPayloadRecord(event: DriverEventInput): Record<string, unknown> {
  const payload = event.payload;
  return isRecord(payload) ? payload : {};
}

function readToolEventType(payload: Record<string, unknown>): CmaOutboundEvent["type"] {
  const kind = payload["kind"];

  if (kind === "mcp") {
    return "agent.mcp_tool_use";
  }

  if (kind === "custom") {
    return "agent.custom_tool_use";
  }

  return "agent.tool_use";
}

function isRecoverableFailure(payload: Record<string, unknown>): boolean {
  if (payload["recoverable"] === true) {
    return true;
  }

  const error = payload["error"];
  return isRecord(error) && error["retryable"] === true;
}

export function projectDriverEventToCma(event: DriverEventInput): CmaOutboundEvent[] {
  const payload = readPayloadRecord(event);

  switch (event.kind) {
    case "message.added":
    case "message.cancelled":
    case "message.completed":
    case "message.delta":
    case "message.failed":
    case "message.started":
      return [{ message: payload, sourceEventKind: event.kind, type: "agent.message" }];
    case "thought.cancelled":
    case "thought.completed":
    case "thought.delta":
    case "thought.started":
      return [{ message: payload, sourceEventKind: event.kind, type: "agent.thinking" }];
    case "tool.call.updated":
      return [{ message: payload, sourceEventKind: event.kind, type: readToolEventType(payload) }];
    case "permission.requested":
      return [
        {
          requiresAction: {
            ...(payload["agentId"] === undefined ? {} : { agentId: payload["agentId"] }),
            ...(payload["blockedPath"] === undefined
              ? {}
              : { blockedPath: payload["blockedPath"] }),
            ...(payload["decisionReason"] === undefined
              ? {}
              : { decisionReason: payload["decisionReason"] }),
            details: payload["details"],
            ...(payload["description"] === undefined
              ? {}
              : { description: payload["description"] }),
            ...(payload["matchedAskRule"] === undefined
              ? {}
              : { matchedAskRule: payload["matchedAskRule"] }),
            requestId: payload["requestId"],
            targetItemId: payload["targetItemId"],
            title: payload["title"],
            toolCall: payload["toolCall"],
          },
          sessionStatus: "idle",
          sourceEventKind: event.kind,
          type: "session.status_idle",
        },
      ];
    case "permission.resolved":
      return [
        {
          metadata: { permissionResult: payload },
          sessionStatus: "running",
          sourceEventKind: event.kind,
          type: "session.status_running",
        },
      ];
    case "run.started":
      return [
        {
          metadata: payload,
          sessionStatus: "running",
          sourceEventKind: event.kind,
          type: "session.status_running",
        },
      ];
    case "run.waiting":
    case "run.cancelled":
    case "run.completed":
      return [
        {
          metadata: payload,
          sessionStatus: "idle",
          sourceEventKind: event.kind,
          type: "session.status_idle",
        },
      ];
    case "run.failed": {
      const recoverable = isRecoverableFailure(payload);
      return [
        {
          error: payload,
          sessionStatus: recoverable ? "rescheduling" : "terminated",
          sourceEventKind: event.kind,
          type: recoverable ? "session.status_rescheduling" : "session.error",
        },
      ];
    }
    case "usage.updated":
      return [{ sourceEventKind: event.kind, type: "session.usage", usage: payload }];
    default:
      return [];
  }
}
