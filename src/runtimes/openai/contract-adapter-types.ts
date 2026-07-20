import type { MutationCause, Run, TokenUsage } from "../../contract";
import type { ContractAuthorityUpdate, ContractProjectionOptions } from "../contract-projection";
import type { JsonRpcId } from "./app-server-json";

export interface OpenAiTurnState {
  cause: MutationCause;
  run: Run;
  runId: string;
  threadId: string;
  turnId: string;
  usageBaseline?: TokenUsage;
}

export interface PendingOpenAiTurnAttachment {
  cause: MutationCause;
  mutationId: string;
  run: Run;
  task?: Promise<void> | undefined;
  turn: OpenAiTurnState;
}

export interface OpenAiAuthorityUpdate extends ContractAuthorityUpdate {
  readonly turnId: string;
}

export interface OpenAiContractAdapterOptions extends Omit<ContractProjectionOptions, "authority"> {
  readonly authority: (update: OpenAiAuthorityUpdate) => Promise<void>;
  readonly createId?: (() => string) | undefined;
  readonly interactionTimeoutMs?: number | undefined;
  readonly maxPendingServerRequestBytes?: number | undefined;
}

export interface OpenAiTurnAttachment {
  readonly cause: MutationCause;
  readonly run: Run;
  readonly threadId: string;
  readonly turnId: string;
}

export interface OpenAiServerReply {
  readonly id: JsonRpcId;
  readonly result: unknown;
}
