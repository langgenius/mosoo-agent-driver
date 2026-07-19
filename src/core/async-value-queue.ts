export interface AsyncValueQueueReserve {
  readonly maxBytes: number;
  readonly maxSize: number;
}

interface BufferedValue<T> {
  readonly bytes: number;
  readonly reserved: boolean;
  readonly value: T;
}

export class AsyncValueQueue<T> {
  readonly #label: string;
  readonly #maxBytes: number;
  readonly #maxSize: number;
  readonly #measure: (value: T) => number;
  readonly #reserve: AsyncValueQueueReserve | undefined;
  readonly #values: BufferedValue<T>[] = [];
  readonly #waiters: PromiseWithResolvers<IteratorResult<T>>[] = [];
  #bytes = 0;
  #closed = false;
  #reservedBytes = 0;
  #reservedSize = 0;
  #size = 0;

  constructor(
    label: string,
    maxSize: number,
    maxBytes = Number.POSITIVE_INFINITY,
    measure: (value: T) => number = () => 0,
    reserve?: AsyncValueQueueReserve,
  ) {
    this.#label = label;
    this.#maxBytes = maxBytes;
    this.#maxSize = maxSize;
    this.#measure = measure;
    this.#reserve = reserve;
  }

  close(options: { readonly discard?: boolean } = {}): void {
    if (options.discard) {
      this.#values.length = 0;
      this.#bytes = 0;
      this.#reservedBytes = 0;
      this.#reservedSize = 0;
      this.#size = 0;
    }

    if (this.#closed) {
      return;
    }

    this.#closed = true;

    for (const waiter of this.#waiters.splice(0)) {
      waiter.resolve({
        done: true,
        value: undefined,
      });
    }
  }

  next(): Promise<IteratorResult<T>> {
    const buffered = this.#values.shift();

    if (buffered !== undefined) {
      if (buffered.reserved) {
        this.#reservedBytes -= buffered.bytes;
        this.#reservedSize -= 1;
      } else {
        this.#bytes -= buffered.bytes;
        this.#size -= 1;
      }
      return Promise.resolve({
        done: false,
        value: buffered.value,
      });
    }

    if (this.#closed) {
      return Promise.resolve({
        done: true,
        value: undefined,
      });
    }

    const waiter = Promise.withResolvers<IteratorResult<T>>();
    this.#waiters.push(waiter);
    return waiter.promise;
  }

  push(value: T): void {
    this.pushMany([value]);
  }

  pushReserved(value: T): void {
    if (this.#closed) {
      throw new Error("Driver kernel queue is closed.");
    }
    if (this.#reserve === undefined) {
      throw new Error(`Driver kernel ${this.#label} queue has no reserve.`);
    }

    const buffered = this.#buffer(value, true);
    if (buffered.bytes > this.#reserve.maxBytes) {
      throw new Error(
        `Driver kernel ${this.#label} queue reserve exceeds ${this.#reserve.maxBytes} UTF-8 JSON bytes.`,
      );
    }

    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ done: false, value });
      return;
    }

    if (this.#reservedSize >= this.#reserve.maxSize) {
      throw new Error(
        `Driver kernel ${this.#label} queue reserve exceeds ${this.#reserve.maxSize} items.`,
      );
    }
    if (buffered.bytes > this.#reserve.maxBytes - this.#reservedBytes) {
      throw new Error(
        `Driver kernel ${this.#label} queue reserve exceeds ${this.#reserve.maxBytes} UTF-8 JSON bytes.`,
      );
    }

    this.#values.push(buffered);
    this.#reservedBytes += buffered.bytes;
    this.#reservedSize += 1;
  }

  pushMany(values: readonly T[]): void {
    if (this.#closed) {
      throw new Error("Driver kernel queue is closed.");
    }

    const directCount = Math.min(values.length, this.#waiters.length);
    const buffered = values.slice(directCount).map((value) => this.#buffer(value));

    if (this.#size + buffered.length > this.#maxSize) {
      throw new Error(`Driver kernel ${this.#label} queue exceeds ${this.#maxSize} items.`);
    }
    const addedBytes = buffered.reduce((sum, entry) => sum + entry.bytes, 0);
    if (addedBytes > this.#maxBytes - this.#bytes) {
      throw new Error(
        `Driver kernel ${this.#label} queue exceeds ${this.#maxBytes} UTF-8 JSON bytes.`,
      );
    }

    for (const value of values.slice(0, directCount)) {
      const waiter = this.#waiters.shift();
      waiter?.resolve({ done: false, value });
    }
    this.#values.push(...buffered);
    this.#bytes += addedBytes;
    this.#size += buffered.length;
  }

  async *values(): AsyncIterable<T> {
    while (true) {
      const result = await this.next();

      if (result.done) {
        return;
      }

      yield result.value;
    }
  }

  #buffer(value: T, reserved = false): BufferedValue<T> {
    const bytes = this.#measure(value);
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new RangeError(`Driver kernel ${this.#label} queue measured invalid bytes.`);
    }
    return { bytes, reserved, value };
  }
}
