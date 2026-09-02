const taskRetries = new WeakMap<Promise<unknown>, () => Promise<unknown>>();
const retryableTaskFailures = new WeakSet<Promise<unknown>>();

type ClaudeTaskDrainResult =
  | { readonly status: "completed" }
  | {
      readonly firstFailure: unknown;
      readonly firstPermanentFailure: { readonly error: unknown } | null;
      readonly status: "failed";
    };

export function registerClaudeTaskRetry<T>(task: Promise<T>, retry: () => Promise<T>): void {
  taskRetries.set(task, retry);
}

export async function drainClaudeTasks(
  ...taskSets: ReadonlyArray<Set<Promise<unknown>>>
): Promise<void> {
  const result = await settleClaudeTasks(...taskSets);
  if (result.status === "failed") {
    throw result.firstFailure;
  }
}

export async function settleClaudeTasks(
  ...taskSets: ReadonlyArray<Set<Promise<unknown>>>
): Promise<ClaudeTaskDrainResult> {
  const failedRetryableTasks = new Set<Promise<unknown>>();
  let failed = false;
  let firstFailure: unknown;
  let firstPermanentFailure: { readonly error: unknown } | null = null;

  for (;;) {
    const tasks = taskSets.flatMap((taskSet) =>
      [...taskSet]
        .filter((task) => !failedRetryableTasks.has(task))
        .map((task) => ({ owner: taskSet, retry: taskRetries.get(task), task })),
    );
    if (tasks.length === 0) {
      break;
    }

    const results = await Promise.allSettled(
      tasks.map(({ retry, task }) => {
        if (retry !== undefined && retryableTaskFailures.has(task)) {
          return Promise.resolve().then(retry);
        }
        return task;
      }),
    );
    for (const [index, result] of results.entries()) {
      const tracked = tasks[index]!;
      if (result.status === "fulfilled") {
        tracked.owner.delete(tracked.task);
        taskRetries.delete(tracked.task);
        retryableTaskFailures.delete(tracked.task);
      } else {
        if (tracked.retry !== undefined) {
          retryableTaskFailures.add(tracked.task);
          failedRetryableTasks.add(tracked.task);
        } else {
          tracked.owner.delete(tracked.task);
          firstPermanentFailure ??= { error: result.reason };
        }
        if (!failed) {
          failed = true;
          firstFailure = result.reason;
        }
      }
    }
  }

  if (failed) {
    return { firstFailure, firstPermanentFailure, status: "failed" };
  }
  return { status: "completed" };
}
