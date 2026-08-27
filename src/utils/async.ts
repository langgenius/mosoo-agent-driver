class AsyncTimeoutError extends Error {
  readonly label: string;
  readonly timeoutMs: number;

  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms.`);
    this.name = "AsyncTimeoutError";
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

interface PromiseTimeoutOptions {
  readonly label: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}

type PromiseTimeoutResult<T> =
  | {
      readonly status: "completed";
      readonly value: T;
    }
  | {
      readonly error: AsyncTimeoutError;
      readonly status: "timed_out";
    }
  | {
      readonly error: unknown;
      readonly status: "failed";
    };

const MAX_TIMER_MS = 2_147_483_647;

function assertTimerMs(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative millisecond value.`);
  }
}

export async function promiseWithTimeout<T>(
  promise: Promise<T>,
  options: PromiseTimeoutOptions,
): Promise<T> {
  const result = await settleWithTimeout(promise, options);

  if (result.status === "completed") {
    return result.value;
  }

  throw result.error;
}

async function settleWithTimeout<T>(
  promise: Promise<T>,
  options: PromiseTimeoutOptions,
): Promise<PromiseTimeoutResult<T>> {
  const operation = promise.then<PromiseTimeoutResult<T>, PromiseTimeoutResult<T>>(
    (value) => ({ status: "completed", value }),
    (error: unknown) => ({ error, status: "failed" }),
  );
  assertTimerMs(options.timeoutMs, options.label);

  if (options.signal?.aborted) {
    return { error: options.signal.reason, status: "failed" };
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<PromiseTimeoutResult<T>>((resolve) => {
    timeoutId = setTimeout(
      () => {
        resolve({
          error: new AsyncTimeoutError(options.label, options.timeoutMs),
          status: "timed_out",
        });
      },
      Math.min(options.timeoutMs, MAX_TIMER_MS),
    );
  });
  const aborted = new Promise<PromiseTimeoutResult<T>>((resolve) => {
    if (options.signal === undefined) {
      return;
    }

    onAbort = () => resolve({ error: options.signal?.reason, status: "failed" });
    options.signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    return await Promise.race([operation, timeout, aborted]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
    if (onAbort !== undefined) {
      options.signal?.removeEventListener("abort", onAbort);
    }
  }
}

export async function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) {
    return promise;
  }

  if (signal.aborted) {
    void promise.catch(() => {});
    throw signal.reason;
  }
  const aborted = Promise.withResolvers<never>();
  const onAbort = () => aborted.reject(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    return await Promise.race([promise, aborted.promise]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export async function readBoundedStreamBytes(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  limitError: Error,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const reader = body.getReader();
  let bytes = new Uint8Array(0);
  let cancellation: Promise<void> | undefined;
  let completed = false;
  let size = 0;
  const cancel = () =>
    (cancellation ??= reader.cancel(signal?.reason).then(
      () => undefined,
      () => undefined,
    ));
  const onAbort = () => void cancel();
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    signal?.throwIfAborted();

    while (true) {
      const chunk = await raceWithAbort(reader.read(), signal);
      signal?.throwIfAborted();

      if (chunk.done) {
        completed = true;
        break;
      }

      if (chunk.value.byteLength > maxBytes - size) {
        throw limitError;
      }

      const nextSize = size + chunk.value.byteLength;

      if (nextSize > bytes.byteLength) {
        const grown = new Uint8Array(
          Math.min(maxBytes, Math.max(nextSize, bytes.byteLength * 2, 1_024)),
        );
        grown.set(bytes);
        bytes = grown;
      }

      bytes.set(chunk.value, size);
      size = nextSize;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);

    if (!completed) {
      await cancel();
    }

    reader.releaseLock();
  }

  return bytes.subarray(0, size);
}

export function settlePromiseWithTimeout<T>(
  promise: Promise<T>,
  options: PromiseTimeoutOptions,
): Promise<PromiseTimeoutResult<T>> {
  return settleWithTimeout(promise, options);
}

export async function sleepPromise(ms: number, signal?: AbortSignal): Promise<void> {
  assertTimerMs(ms, "sleep");
  signal?.throwIfAborted();

  await new Promise<void>((resolve, reject) => {
    const timeoutId = setTimeout(
      () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      },
      Math.min(ms, MAX_TIMER_MS),
    );
    const onAbort = () => {
      clearTimeout(timeoutId);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
