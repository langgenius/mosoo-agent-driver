import "bun:test";

declare module "bun:test" {
  interface Test<T extends ReadonlyArray<unknown>> {
    each(table: readonly unknown[]): Test<any>;
  }

  interface Matchers<T = unknown> {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toStrictEqual(expected: unknown): void;
  }
}
