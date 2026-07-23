const taskRetries = new WeakMap<Promise<unknown>, () => Promise<unknown>>();
const retryableTaskFailures = new WeakSet<Promise<unknown>>();

export function registerClaudeTaskRetry<T>(task: Promise<T>, retry: () => Promise<T>): void {
  taskRetries.set(task, retry);
}

export async function drainClaudeTasks(
  ...taskSets: ReadonlyArray<Set<Promise<unknown>>>
): Promise<void> {
  const failedRetryableTasks = new Set<Promise<unknown>>();
  let failed = false;
  let firstFailure: unknown;

  for (;;) {
    const tasks = taskSets.flatMap((taskSet) =>
      [...taskSet]
        .filter((task) => !failedRetryableTasks.has(task))
        .map((task) => ({ owner: taskSet, task })),
    );
    if (tasks.length === 0) {
      break;
    }

    const results = await Promise.allSettled(
      tasks.map(({ task }) => {
        const retry = taskRetries.get(task);
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
        if (taskRetries.has(tracked.task)) {
          retryableTaskFailures.add(tracked.task);
          failedRetryableTasks.add(tracked.task);
        } else {
          tracked.owner.delete(tracked.task);
        }
        if (!failed) {
          failed = true;
          firstFailure = result.reason;
        }
      }
    }
  }

  if (failed) {
    throw firstFailure;
  }
}
