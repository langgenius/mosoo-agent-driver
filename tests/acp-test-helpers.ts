import type { RunId } from "../src/protocol/id";
import {
  AcpAssistantTranscriptState,
  type AcpAssistantTranscriptStateInput,
} from "../src/runtimes/acp/acp-assistant-transcript-state";

export function beginAcpTranscript(
  input: Partial<AcpAssistantTranscriptStateInput> = {},
): AcpAssistantTranscriptState {
  const state = new AcpAssistantTranscriptState();
  state.begin({ messageId: "message-1", runId: "run-1" as RunId, ...input });
  return state;
}

export async function waitForAcpTestCondition(
  condition: () => boolean | Promise<boolean>,
  description: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await condition()) {
      return;
    }
    await Bun.sleep(5);
  }

  throw new Error(`Timed out waiting for ${description}.`);
}
