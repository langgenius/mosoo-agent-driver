export const OPENAI_APP_SERVER_SCHEMA_VERSION = "0.144.5" as const;

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = Readonly<Record<string, unknown>>;

export type RequestId = number | string;
export type ApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never";
export type ImageDetail = "high" | "original";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type SandboxPolicy = SandboxMode | JsonObject;

export type UserInput =
  | { type: "text"; text: string; text_elements: [] }
  | { type: "image"; detail?: ImageDetail; url: string }
  | { type: "localImage"; detail?: ImageDetail; path: string }
  | { type: "skill"; name: string; path: string }
  | { type: "mention"; name: string; path: string };

export interface InitializeParams {
  capabilities: {
    experimentalApi: boolean;
    requestAttestation: boolean;
  } | null;
  clientInfo: {
    name: string;
    title?: string;
    version: string;
  };
}

export interface InitializeResponse {
  protocolVersion?: string;
}

export interface ThreadStartParams {
  approvalPolicy?: ApprovalPolicy | null;
  approvalsReviewer?: string | JsonObject | null;
  baseInstructions?: string | null;
  config?: JsonObject | null;
  cwd?: string | null;
  developerInstructions?: string | null;
  ephemeral?: boolean | null;
  model?: string | null;
  modelProvider?: string | null;
  sandbox?: SandboxMode | null;
  serviceName?: string | null;
  serviceTier?: string | null;
  sessionStartSource?: string | null;
}

export interface ThreadResumeParams extends Omit<
  ThreadStartParams,
  "ephemeral" | "serviceName" | "sessionStartSource"
> {
  threadId: string;
}

export type ThreadActiveFlag = "waitingOnApproval" | "waitingOnUserInput";

export type ThreadStatus =
  | { type: "notLoaded" }
  | { type: "idle" }
  | { type: "systemError" }
  | { type: "active"; activeFlags: ThreadActiveFlag[] };

export interface Thread {
  id: string;
  status?: ThreadStatus;
}

export interface ThreadStartResponse {
  thread: Thread;
}

export interface ThreadResumeResponse {
  thread: Thread;
}

export interface ThreadInjectItemsParams {
  items: JsonObject[];
  threadId: string;
}

export type ThreadInjectItemsResponse = Record<string, never>;

export interface TurnStartParams {
  approvalPolicy?: ApprovalPolicy | null;
  approvalsReviewer?: string | JsonObject | null;
  cwd?: string | null;
  effort?: string | null;
  input: UserInput[];
  model?: string | null;
  outputSchema?: JsonValue | null;
  sandboxPolicy?: SandboxPolicy | null;
  serviceTier?: string | null;
  summary?: string | null;
  threadId: string;
}

export type TurnStatus = "completed" | "interrupted" | "failed" | "inProgress";
export type TurnItemsView = "notLoaded" | "summary" | "full";

export type PatchChangeKind =
  | { type: "add" }
  | { type: "delete" }
  | { move_path: string | null; type: "update" };

export interface FileUpdateChange {
  diff: string;
  kind: PatchChangeKind;
  path: string;
}

export type TurnPlanStepStatus = "pending" | "inProgress" | "completed";

export interface TurnPlanStep {
  status: TurnPlanStepStatus;
  step: string;
}

export type ThreadItem = JsonObject & {
  id?: string;
  type: string;
};

export interface Turn {
  completedAt?: number | null;
  durationMs?: number | null;
  error?: TurnError | null;
  id: string;
  items?: ThreadItem[];
  itemsView?: TurnItemsView;
  startedAt?: number | null;
  status?: TurnStatus;
}

export interface TurnStartResponse {
  turn: Required<Turn>;
}

export interface TurnInterruptParams {
  threadId: string;
  turnId: string;
}

export interface TurnInterruptResponse {
  turn?: Turn;
}

export interface TokenUsageBreakdown {
  cachedInputTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface ThreadTokenUsage {
  last: TokenUsageBreakdown;
  modelContextWindow: number | null;
  total: TokenUsageBreakdown;
}

export interface ItemNotificationBase {
  completedAtMs?: number;
  item?: ThreadItem;
  itemId?: string;
  startedAtMs?: number;
  threadId?: string;
  turnId?: string;
}

export interface PlanDeltaNotification {
  delta: string;
  itemId: string;
  threadId: string;
  turnId: string;
}

export interface TurnPlanUpdatedNotification {
  explanation: string | null;
  plan: TurnPlanStep[];
  threadId: string;
  turnId: string;
}

export interface TurnDiffUpdatedNotification {
  diff: string;
  threadId: string;
  turnId: string;
}

export interface FileChangePatchUpdatedNotification {
  changes: FileUpdateChange[];
  itemId: string;
  threadId: string;
  turnId: string;
}

export interface ReasoningTextDeltaNotification {
  contentIndex: number;
  delta: string;
  itemId: string;
  threadId: string;
  turnId: string;
}

export interface ReasoningSummaryPartAddedNotification {
  itemId: string;
  summaryIndex: number;
  threadId: string;
  turnId: string;
}

export interface ReasoningSummaryTextDeltaNotification {
  delta: string;
  itemId: string;
  summaryIndex: number;
  threadId: string;
  turnId: string;
}

export interface McpToolCallProgressNotification {
  itemId: string;
  message: string;
  threadId: string;
  turnId: string;
}

export interface ServerRequestResolvedNotification {
  requestId: RequestId;
  threadId: string;
}

export interface TextPosition {
  column: number;
  line: number;
}

export interface TextRange {
  end: TextPosition;
  start: TextPosition;
}

export interface ConfigWarningNotification {
  details?: string | null;
  path?: string | null;
  range?: TextRange | null;
  summary: string;
}

export interface WarningNotification {
  message: string;
  threadId: string | null;
}

export interface TurnError {
  additionalDetails: string | null;
  message: string;
}

export interface ErrorNotification {
  error: TurnError;
  threadId: string;
  turnId: string;
  willRetry: boolean;
}

export type RemoteControlConnectionStatus = "disabled" | "connecting" | "connected" | "errored";

export interface RemoteControlStatusChangedNotification {
  environmentId?: string | null;
  installationId: string;
  serverName: string;
  status: RemoteControlConnectionStatus;
}

export interface ThreadSettingsUpdatedNotification {
  threadId: string;
  threadSettings: JsonObject;
}

export interface AgentMessageDeltaNotification {
  delta: string;
  itemId: string;
  threadId: string;
  turnId: string;
}

export interface ServerNotificationParams {
  configWarning: ConfigWarningNotification;
  error: ErrorNotification;
  "item/agentMessage/delta": AgentMessageDeltaNotification;
  "item/commandExecution/outputDelta": {
    delta?: string;
    itemId?: string;
    threadId?: string;
    turnId?: string;
  };
  "item/completed": ItemNotificationBase;
  "item/fileChange/outputDelta": {
    delta?: string;
    itemId?: string;
    threadId?: string;
    turnId?: string;
  };
  "item/fileChange/patchUpdated": FileChangePatchUpdatedNotification;
  "item/mcpToolCall/progress": McpToolCallProgressNotification;
  "item/plan/delta": PlanDeltaNotification;
  "item/reasoning/summaryPartAdded": ReasoningSummaryPartAddedNotification;
  "item/reasoning/summaryTextDelta": ReasoningSummaryTextDeltaNotification;
  "item/reasoning/textDelta": ReasoningTextDeltaNotification;
  "item/started": ItemNotificationBase;
  "remoteControl/status/changed": RemoteControlStatusChangedNotification;
  "serverRequest/resolved": ServerRequestResolvedNotification;
  "thread/settings/updated": ThreadSettingsUpdatedNotification;
  "thread/started": { thread: Thread };
  "thread/status/changed": { status: ThreadStatus; threadId: string };
  "thread/tokenUsage/updated": { threadId: string; tokenUsage: ThreadTokenUsage; turnId: string };
  "turn/completed": { threadId: string; turn: Turn };
  "turn/diff/updated": TurnDiffUpdatedNotification;
  "turn/plan/updated": TurnPlanUpdatedNotification;
  "turn/started": { threadId: string; turn: Turn };
  warning: WarningNotification;
}

export type ServerNotificationMethod = keyof ServerNotificationParams;

export interface ClientRequestParams {
  initialize: InitializeParams;
  "thread/inject_items": ThreadInjectItemsParams;
  "thread/resume": ThreadResumeParams;
  "thread/start": ThreadStartParams;
  "turn/interrupt": TurnInterruptParams;
  "turn/start": TurnStartParams;
}

export interface ClientRequestResult {
  initialize: InitializeResponse;
  "thread/inject_items": ThreadInjectItemsResponse;
  "thread/resume": ThreadResumeResponse;
  "thread/start": ThreadStartResponse;
  "turn/interrupt": TurnInterruptResponse;
  "turn/start": TurnStartResponse;
}

export type ClientRequestMethod = keyof ClientRequestParams;

export interface CommandExecutionRequestApprovalResponse {
  decision: "accept" | "acceptForSession" | "decline" | "cancel" | JsonObject;
}

export interface FileChangeRequestApprovalResponse {
  decision: "accept" | "acceptForSession" | "decline" | "cancel";
}

export interface PermissionsRequestApprovalResponse {
  permissions: JsonObject;
  scope: "turn" | "session";
  strictAutoReview?: boolean;
}

export interface ToolRequestUserInputResponse {
  answers: Record<string, { answers: string[] }>;
}

export interface DynamicToolCallResponse {
  contentItems: Array<
    { type: "inputText"; text: string } | { type: "inputImage"; imageUrl: string }
  >;
  success: boolean;
}

export interface ChatgptAuthTokensRefreshResponse {
  accessToken: string;
  chatgptAccountId: string;
  chatgptPlanType: string | null;
}

export interface AttestationGenerateResponse {
  token: string;
}

export interface CurrentTimeReadResponse {
  currentTimeAt: number;
}

export interface McpServerElicitationRequestResponse {
  _meta: JsonValue | null;
  action: "accept" | "decline" | "cancel";
  content: JsonValue | null;
}

export interface ServerRequestParams {
  "account/chatgptAuthTokens/refresh": JsonObject;
  "attestation/generate": JsonObject;
  "currentTime/read": JsonObject;
  "item/commandExecution/requestApproval": JsonObject;
  "item/fileChange/requestApproval": JsonObject;
  "item/permissions/requestApproval": JsonObject;
  "item/tool/call": JsonObject;
  "item/tool/requestUserInput": JsonObject;
  "mcpServer/elicitation/request": JsonObject;
}

export interface ServerRequestResult {
  "account/chatgptAuthTokens/refresh": ChatgptAuthTokensRefreshResponse;
  "attestation/generate": AttestationGenerateResponse;
  "currentTime/read": CurrentTimeReadResponse;
  "item/commandExecution/requestApproval": CommandExecutionRequestApprovalResponse;
  "item/fileChange/requestApproval": FileChangeRequestApprovalResponse;
  "item/permissions/requestApproval": PermissionsRequestApprovalResponse;
  "item/tool/call": DynamicToolCallResponse;
  "item/tool/requestUserInput": ToolRequestUserInputResponse;
  "mcpServer/elicitation/request": McpServerElicitationRequestResponse;
}

export type ServerRequestMethod = keyof ServerRequestParams;

const SERVER_NOTIFICATION_METHODS = new Set<string>([
  "configWarning",
  "error",
  "item/agentMessage/delta",
  "item/commandExecution/outputDelta",
  "item/completed",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
  "item/mcpToolCall/progress",
  "item/plan/delta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "item/started",
  "remoteControl/status/changed",
  "serverRequest/resolved",
  "thread/settings/updated",
  "thread/started",
  "thread/status/changed",
  "thread/tokenUsage/updated",
  "turn/completed",
  "turn/diff/updated",
  "turn/plan/updated",
  "turn/started",
  "warning",
]);

const SERVER_REQUEST_METHODS = new Set<string>([
  "account/chatgptAuthTokens/refresh",
  "attestation/generate",
  "currentTime/read",
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/call",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
]);

export function isServerNotificationMethod(method: string): method is ServerNotificationMethod {
  return SERVER_NOTIFICATION_METHODS.has(method);
}

export function isServerRequestMethod(method: string): method is ServerRequestMethod {
  return SERVER_REQUEST_METHODS.has(method);
}
