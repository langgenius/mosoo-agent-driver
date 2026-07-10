export interface BenchmarkTrialMetrics {
  readonly bootMs: number;
  readonly deltaCount: number;
  readonly error: string | null;
  readonly fileCreated: boolean | null;
  readonly firstTextMs: number | null;
  readonly interChunkMax: number | null;
  readonly interChunkP50: number | null;
  readonly interChunkP95: number | null;
  readonly markerPresent: boolean | null;
  readonly outputChars: number;
  readonly permissionRequestCount: number;
  readonly policyEnforced: boolean | null;
  readonly taskCompleted: boolean;
  readonly totalMs: number | null;
  readonly ttftMs: number | null;
}

export interface BenchmarkTrialAggregate {
  readonly bootP50: number | null;
  readonly bootP95: number | null;
  readonly deltaCountP50: number | null;
  readonly fileCreatedRate: number | null;
  readonly firstTextP50: number | null;
  readonly firstTextP95: number | null;
  readonly interChunkP50: number | null;
  readonly interChunkP95: number | null;
  readonly policyEnforcedRate: number | null;
  readonly taskCompletedRate: number | null;
  readonly totalP50: number | null;
  readonly totalP95: number | null;
  readonly ttftP50: number | null;
  readonly ttftP95: number | null;
  readonly turnCompletedRate: number | null;
}

function percentile(values: number[], p: number): number | null {
  const clean = values.filter((value) => Number.isFinite(value)).toSorted((a, b) => a - b);
  if (clean.length === 0) {
    return null;
  }
  const index = Math.min(clean.length - 1, Math.max(0, Math.ceil((p / 100) * clean.length) - 1));
  return clean[index] ?? null;
}

function rate(values: readonly boolean[]): number | null {
  if (values.length === 0) {
    return null;
  }

  return values.filter(Boolean).length / values.length;
}

export function aggregateBenchmarkTrials(
  trials: readonly BenchmarkTrialMetrics[],
): BenchmarkTrialAggregate {
  const completedTurns = trials.filter((trial) => trial.totalMs !== null && trial.error === null);
  const pickCompleted = (key: keyof BenchmarkTrialMetrics): number[] =>
    completedTurns
      .map((trial) => trial[key])
      .filter((value): value is number => typeof value === "number");
  const fileTrials = trials.filter((trial) => trial.fileCreated !== null);
  const policyTrials = trials.filter(
    (trial): trial is BenchmarkTrialMetrics & { readonly policyEnforced: boolean } =>
      trial.policyEnforced !== null,
  );

  return {
    bootP50: percentile(pickCompleted("bootMs"), 50),
    bootP95: percentile(pickCompleted("bootMs"), 95),
    deltaCountP50: percentile(pickCompleted("deltaCount"), 50),
    fileCreatedRate: rate(fileTrials.map((trial) => trial.fileCreated === true)),
    firstTextP50: percentile(pickCompleted("firstTextMs"), 50),
    firstTextP95: percentile(pickCompleted("firstTextMs"), 95),
    interChunkP50: percentile(pickCompleted("interChunkP50"), 50),
    interChunkP95: percentile(pickCompleted("interChunkP95"), 95),
    policyEnforcedRate: rate(policyTrials.map((trial) => trial.policyEnforced)),
    taskCompletedRate: rate(trials.map((trial) => trial.taskCompleted)),
    totalP50: percentile(pickCompleted("totalMs"), 50),
    totalP95: percentile(pickCompleted("totalMs"), 95),
    ttftP50: percentile(pickCompleted("ttftMs"), 50),
    ttftP95: percentile(pickCompleted("ttftMs"), 95),
    turnCompletedRate: rate(trials.map((trial) => trial.totalMs !== null && trial.error === null)),
  };
}
