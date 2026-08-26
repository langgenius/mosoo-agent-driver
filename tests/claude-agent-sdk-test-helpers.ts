import type { DriverEventInput } from "../src/protocol/events";
import { isRecord } from "../src/runtimes/claude/agent-sdk-json";

export { isRecord } from "../src/runtimes/claude/agent-sdk-json";

export function messageText(events: readonly DriverEventInput[], messageId: unknown): string {
  let text = "";

  for (const event of events) {
    if (!isRecord(event.payload) || event.payload["messageId"] !== messageId) {
      continue;
    }

    if (event.kind === "message.added") {
      const content = event.payload["content"];
      text = Array.isArray(content)
        ? content
            .flatMap((block) =>
              isRecord(block) && typeof block["text"] === "string" ? [block["text"]] : [],
            )
            .join("")
        : typeof content === "string"
          ? content
          : "";
    } else if (
      event.kind === "message.delta" &&
      typeof event.payload["contentDelta"] === "string"
    ) {
      text += event.payload["contentDelta"];
    }
  }

  return text;
}
