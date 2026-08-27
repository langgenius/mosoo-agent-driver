import type {
  ClientRequest as GeneratedClientRequest,
  RequestId as GeneratedRequestId,
  ServerNotification as GeneratedServerNotification,
  ServerRequest as GeneratedServerRequest,
} from "./generated";
import type {
  AskForApproval,
  CurrentTimeReadResponse as GeneratedCurrentTimeReadResponse,
  ThreadInjectItemsParams as GeneratedThreadInjectItemsParams,
  ThreadResumeParams as GeneratedThreadResumeParams,
  ThreadStartParams as GeneratedThreadStartParams,
  TurnStartParams as GeneratedTurnStartParams,
  TurnStatus as GeneratedTurnStatus,
} from "./generated/v2";
import type { JsonObject } from "./app-server-json";

type WireServerNotification = Exclude<
  GeneratedServerNotification,
  { method: "rawResponse/completed" | "rawResponseItem/completed" }
>;

export type RequestId = GeneratedRequestId;
export type ApprovalPolicy = AskForApproval;
export type ThreadStartParams = GeneratedThreadStartParams;
export type ThreadResumeParams = GeneratedThreadResumeParams;
export type ThreadInjectItemsParams = GeneratedThreadInjectItemsParams;
export type TurnStartParams = GeneratedTurnStartParams;
export type TurnStatus = GeneratedTurnStatus;

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

type ClientRequestParamsFor<Method extends ClientRequestMethod> =
  Extract<GeneratedClientRequest, { method: Method }> extends { params: infer Params }
    ? Params
    : never;

export type ClientRequestParams = {
  [Method in ClientRequestMethod]: ClientRequestParamsFor<Method>;
};

export type ServerNotificationMethod = WireServerNotification["method"];
export type ServerNotificationParams = {
  [Method in ServerNotificationMethod]: JsonObject;
};

export interface ParsedServerNotification {
  emittedAtMs?: number;
  method: ServerNotificationMethod;
  params: JsonObject;
}

export type ServerRequestMethod = GeneratedServerRequest["method"];

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

export type CurrentTimeReadResponse = GeneratedCurrentTimeReadResponse;
