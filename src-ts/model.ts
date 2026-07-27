import { createOpenAI, type OpenAIProvider } from "@ai-sdk/openai";

import { resolveBraintrustGatewayUrl, resolveOpenAIApiKey } from "./tracing.js";

let provider: OpenAIProvider | null = null;

export function getOpenAIProvider(): OpenAIProvider {
  if (!provider) {
    const apiKey = resolveOpenAIApiKey();
    provider = createOpenAI({ apiKey, baseURL: resolveBraintrustGatewayUrl() });
  }
  return provider;
}

export function openaiModel(modelName: string) {
  return getOpenAIProvider()(modelName);
}
