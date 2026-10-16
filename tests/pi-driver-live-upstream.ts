export const PI_LIVE_UPSTREAM_ENV = "AGENT_DRIVER_LIVE_OPENROUTER_BASE_URL";
export const DEFAULT_PI_LIVE_UPSTREAM_BASE_URL = "https://openrouter.ai/api/v1";

export function piLiveChatCompletionsUrl(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const configured = environment[PI_LIVE_UPSTREAM_ENV]?.trim();
  const baseUrl =
    configured && configured.length > 0
      ? configured.replace(/\/$/, "")
      : DEFAULT_PI_LIVE_UPSTREAM_BASE_URL;
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${PI_LIVE_UPSTREAM_ENV} must use HTTP or HTTPS.`);
  }
  return `${baseUrl}/chat/completions`;
}
