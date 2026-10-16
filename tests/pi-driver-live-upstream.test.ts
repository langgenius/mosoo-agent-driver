import { describe, expect, test } from "bun:test";

import {
  DEFAULT_PI_LIVE_UPSTREAM_BASE_URL,
  PI_LIVE_UPSTREAM_ENV,
  piLiveChatCompletionsUrl,
} from "./pi-driver-live-upstream";

describe("Pi live upstream fixture", () => {
  test("appends chat completions to the configured base URL", () => {
    expect(
      piLiveChatCompletionsUrl({
        [PI_LIVE_UPSTREAM_ENV]: "http://configured.example/v1/",
      }),
    ).toBe("http://configured.example/v1/chat/completions");
  });

  test("uses the default OpenRouter base URL when unset", () => {
    expect(piLiveChatCompletionsUrl({})).toBe(
      `${DEFAULT_PI_LIVE_UPSTREAM_BASE_URL}/chat/completions`,
    );
  });
});
