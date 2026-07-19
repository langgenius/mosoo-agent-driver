import { promiseWithTimeout } from "../../utils/async";

const ACP_STARTUP_STAGE_TIMEOUT_MS = 30_000;

export async function withAcpStartupStage<T>(
  stage: string,
  task: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  try {
    signal.throwIfAborted();
    return await promiseWithTimeout(task(), {
      label: stage,
      signal,
      timeoutMs: ACP_STARTUP_STAGE_TIMEOUT_MS,
    });
  } catch (error) {
    signal.throwIfAborted();
    throw new Error(
      `${stage} failed: ${error instanceof Error ? error.message : "ACP startup step failed."}`,
      { cause: error },
    );
  }
}
