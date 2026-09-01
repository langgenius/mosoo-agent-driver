interface DriverEventLike {
  readonly kind: string;
  readonly payload: unknown;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function messageText(events: readonly DriverEventLike[], messageId: unknown): string {
  let text = "";

  for (const event of events) {
    const payload = record(event.payload);
    if (payload === null || payload["messageId"] !== messageId) {
      continue;
    }

    if (event.kind === "message.delta" && typeof payload["contentDelta"] === "string") {
      text += payload["contentDelta"];
      continue;
    }

    if (event.kind !== "message.added") {
      continue;
    }

    const content = payload["content"];
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .flatMap((block) => {
          const value = record(block)?.["text"];
          return typeof value === "string" ? [value] : [];
        })
        .join("");
    }
  }

  return text;
}
