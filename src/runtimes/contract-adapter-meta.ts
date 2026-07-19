import { jsonValueSchema } from "../contract";
import type { MutationCause } from "../contract";

export function asJsonValue(value: unknown) {
  const parsed = jsonValueSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function nonEmpty(value: string | null | undefined, fallback: string): string {
  return value?.trim() || fallback;
}

export function createProviderMeta(provider: string) {
  return {
    cause(event: string, id?: string): MutationCause {
      return {
        providerEventId: `${event}${id === undefined ? "" : `:${id}`}`.slice(0, 256),
        type: "provider",
      };
    },
    provenance(event: string, nativeIds?: Readonly<Record<string, string>>) {
      const boundedIds = Object.fromEntries(
        Object.entries(nativeIds ?? {}).filter(
          ([, value]) => value.length > 0 && value.length <= 256,
        ),
      );

      return {
        event,
        ...(Object.keys(boundedIds).length === 0 ? {} : { nativeIds: boundedIds }),
        provider,
      };
    },
  };
}
