// Pi loads this in its own process, where the installed CLI supplies the model catalog.
export const PI_MODEL_CONFIGURATION_SOURCE = `import { getModel } from "@earendil-works/pi-ai";

function configurePiModel(pi, { provider, model: id, api, baseUrl }) {
  const builtin = getModel(provider, id);
  const model = builtin ?? {
    id, name: id, reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000, maxTokens: 16384
  };
  pi.registerProvider(provider, {
    apiKey: "\${MOSOO_PI_PROXY_GRANT}",
    baseUrl,
    api,
    models: [{ ...model, api, baseUrl }]
  });
}`;
