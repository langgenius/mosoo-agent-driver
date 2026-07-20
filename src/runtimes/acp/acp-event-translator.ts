import { AcpAssistantTranscriptState } from "./acp-assistant-transcript-state";

export type { AcpTurnEventStateInput } from "./acp-assistant-transcript-state";
export { AcpAssistantTranscriptState } from "./acp-assistant-transcript-state";
export type { AcpPermissionOption, AcpPermissionTranslation } from "./acp-permission-events";
export { toPermissionRequest, toPermissionResolvedEvent } from "./acp-permission-events";
export {
  shouldIgnoreReplay,
  toAuthEvent,
  toInitializeEvents,
  toPromptStartEvents,
  toSessionReadyEvents,
} from "./acp-session-events";

/** Compatibility façade for the existing runtime boundary. */
export class AcpTurnEventState extends AcpAssistantTranscriptState {}
