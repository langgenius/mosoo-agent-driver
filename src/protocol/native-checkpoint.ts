import { z } from "zod";

import { parseRunId, type RunId } from "./id";
import { parseDriverNativeRuntimeRef, type DriverNativeRuntimeRef } from "./runtime";

export interface NativeCheckpoint {
  readonly formatVersion: 1;
  readonly nativeRef: DriverNativeRuntimeRef;
  readonly runId: RunId;
}

const nativeCheckpointSchema = z.strictObject({
  formatVersion: z.literal(1),
  nativeRef: z.unknown(),
  runId: z.unknown(),
});

export function parseNativeCheckpoint(value: unknown): NativeCheckpoint {
  if (
    value === null ||
    typeof value !== "object" ||
    !["formatVersion", "nativeRef", "runId"].every((key) => Object.hasOwn(value, key))
  ) {
    throw new TypeError("Native checkpoint requires its own formatVersion, nativeRef, and runId.");
  }
  const parsed = nativeCheckpointSchema.safeParse(value);
  if (!parsed.success) {
    throw new TypeError(`Native checkpoint is invalid: ${z.prettifyError(parsed.error)}`);
  }

  return {
    formatVersion: 1,
    nativeRef: parseDriverNativeRuntimeRef(parsed.data.nativeRef),
    runId: parseRunId(parsed.data.runId),
  };
}

export function getNativeCheckpointRelativePath(runId: RunId | string): string {
  return `.state/native-checkpoints/${parseRunId(runId)}`;
}

export function nativeRuntimeRefsEqual(
  left: DriverNativeRuntimeRef,
  right: DriverNativeRuntimeRef,
): boolean {
  return (
    left.kind === right.kind && left.runtimeId === right.runtimeId && left.value === right.value
  );
}

export const NATIVE_CHECKPOINT_MANIFEST_NAME = "manifest.json";
export const MAX_NATIVE_CHECKPOINT_ENTRIES = 10_000;
export const MAX_NATIVE_CHECKPOINT_MANIFEST_BYTES = 2 * 1_024 * 1_024;
export const MAX_NATIVE_CHECKPOINT_DIRECTORY_DEPTH = 64;
export const MAX_NATIVE_CHECKPOINT_FILE_BYTES = 256 * 1_024 * 1_024;

export interface NativeCheckpointFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface NativeCheckpointManifest extends NativeCheckpoint {
  readonly files: readonly NativeCheckpointFile[];
}

const nativeCheckpointManifestSchema = nativeCheckpointSchema.extend({
  files: z
    .array(
      z.strictObject({
        path: z.string().refine((path) => {
          return (
            path !== NATIVE_CHECKPOINT_MANIFEST_NAME &&
            !path.startsWith(`${NATIVE_CHECKPOINT_MANIFEST_NAME}/`) &&
            path.split("/").length <= MAX_NATIVE_CHECKPOINT_DIRECTORY_DEPTH + 1 &&
            !/^[A-Za-z]:/u.test(path) &&
            !path.includes("\\") &&
            !Array.from(path).some((character) => {
              const code = character.charCodeAt(0);
              return code < 0x20 || code === 0x7f;
            }) &&
            path
              .split("/")
              .every((segment) => segment !== "" && segment !== "." && segment !== "..")
          );
        }),
        size: z.number().int().nonnegative().max(MAX_NATIVE_CHECKPOINT_FILE_BYTES),
        sha256: z.string().regex(/^[0-9a-f]{64}$/u),
      }),
    )
    .min(1)
    .max(MAX_NATIVE_CHECKPOINT_ENTRIES),
});

export function parseNativeCheckpointManifest(value: unknown): NativeCheckpointManifest {
  if (
    value === null ||
    typeof value !== "object" ||
    !["formatVersion", "nativeRef", "runId", "files"].every((key) => Object.hasOwn(value, key))
  ) {
    throw new TypeError("Native checkpoint manifest requires its own descriptor and files.");
  }
  const rawFiles = (value as Record<string, unknown>)["files"];
  if (
    Array.isArray(rawFiles) &&
    rawFiles.some(
      (file: unknown) =>
        file === null ||
        typeof file !== "object" ||
        !["path", "size", "sha256"].every((key) => Object.hasOwn(file, key)),
    )
  ) {
    throw new TypeError("Native checkpoint files require their own path, size, and sha256.");
  }
  const parsed = nativeCheckpointManifestSchema.safeParse(value);
  if (!parsed.success) {
    throw new TypeError(`Native checkpoint manifest is invalid: ${z.prettifyError(parsed.error)}`);
  }

  const { files, ...checkpoint } = parsed.data;
  const paths = new Set(files.map((file) => file.path));
  if (paths.size !== files.length) {
    throw new TypeError("Native checkpoint manifest contains duplicate file paths.");
  }
  for (const path of paths) {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      if (paths.has(segments.slice(0, index).join("/"))) {
        throw new TypeError("Native checkpoint manifest contains conflicting file paths.");
      }
    }
  }

  return { ...parseNativeCheckpoint(checkpoint), files };
}
