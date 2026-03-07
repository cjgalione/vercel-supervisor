import { createGoogleGenerativeAI, type GoogleGenerativeAIProvider } from "@ai-sdk/google";

import { resolveGoogleApiKey } from "./tracing.js";

let provider: GoogleGenerativeAIProvider | null = null;

export function getGoogleProvider(): GoogleGenerativeAIProvider {
  if (!provider) {
    const apiKey = resolveGoogleApiKey();
    provider = createGoogleGenerativeAI({ apiKey });
  }
  return provider;
}

export function googleModel(modelName: string) {
  return getGoogleProvider()(modelName);
}
