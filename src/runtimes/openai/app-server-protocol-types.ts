import type { InitializeParams } from "./generated/InitializeParams";
import type { ServerNotificationMethod, ServerRequestMethod } from "./generated/ProtocolMethods";
import type { RequestId } from "./generated/RequestId";
import type { ThreadBackgroundTerminalsCleanParams } from "./generated/v2/ThreadBackgroundTerminalsCleanParams";
import type { ThreadInjectItemsParams } from "./generated/v2/ThreadInjectItemsParams";
import type { ThreadResumeParams } from "./generated/v2/ThreadResumeParams";
import type { ThreadStartParams } from "./generated/v2/ThreadStartParams";
import type { TurnStartParams } from "./generated/v2/TurnStartParams";
import type { TurnStatus } from "./generated/v2/TurnStatus";
import type { JsonObject } from "./app-server-json";

export type { AskForApproval as ApprovalPolicy } from "./generated/v2/AskForApproval";
export type { CurrentTimeReadResponse } from "./generated/v2/CurrentTimeReadResponse";
export type {
  RequestId,
  ServerNotificationMethod,
  ServerRequestMethod,
  ThreadInjectItemsParams,
  ThreadResumeParams,
  ThreadStartParams,
  TurnStartParams,
  TurnStatus,
};

export type InitializeResponse = JsonObject;
export type ThreadStartResponse = JsonObject & { thread: JsonObject & { id: string } };
export type ThreadResumeResponse = ThreadStartResponse;
export type ThreadInjectItemsResponse = JsonObject;
export type ThreadBackgroundTerminalsCleanResponse = JsonObject;
export type TurnStartResponse = JsonObject & {
  turn: JsonObject & { id: string; status: TurnStatus };
};

export interface ClientRequestResult {
  initialize: InitializeResponse;
  "thread/backgroundTerminals/clean": ThreadBackgroundTerminalsCleanResponse;
  "thread/inject_items": ThreadInjectItemsResponse;
  "thread/resume": ThreadResumeResponse;
  "thread/start": ThreadStartResponse;
  "turn/start": TurnStartResponse;
}

export type ClientRequestMethod = keyof ClientRequestResult;

export interface ClientRequestParams {
  initialize: InitializeParams;
  "thread/backgroundTerminals/clean": ThreadBackgroundTerminalsCleanParams;
  "thread/inject_items": ThreadInjectItemsParams;
  "thread/resume": ThreadResumeParams;
  "thread/start": ThreadStartParams;
  "turn/start": TurnStartParams;
}

export type ServerNotificationParams = {
  [Method in ServerNotificationMethod]: JsonObject;
};

export interface ParsedServerNotification {
  emittedAtMs?: number;
  method: ServerNotificationMethod;
  params: JsonObject;
}

export interface ParsedServerRequest {
  id: RequestId;
  method: ServerRequestMethod;
  params: JsonObject;
}

export interface PermissionsRequestApprovalResponse {
  permissions: JsonObject;
  scope: "turn" | "session";
  strictAutoReview?: boolean;
}
