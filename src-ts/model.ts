import { createGoogleGenerativeAI, type GoogleGenerativeAIProvider } from "@ai-sdk/google";
import { createOpenAI, type OpenAIProvider } from "@ai-sdk/openai";

import { resolveGoogleApiKey } from "./tracing.js";

const DEFAULT_BRAINTRUST_GATEWAY_URL = "https://gateway.braintrust.dev";

let googleProvider: GoogleGenerativeAIProvider | null = null;
let gatewayGoogleProvider: GoogleGenerativeAIProvider | null = null;
let gatewayProvider: OpenAIProvider | null = null;
let cachedGatewayGoogleConfig: { baseURL: string; apiKey: string } | null = null;
let cachedGatewayConfig: { baseURL: string; apiKey: string } | null = null;

function envFlagEnabled(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function isGatewayEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlagEnabled(env.BRAINTRUST_USE_GATEWAY);
}

export function resolveGatewayBaseURL(env: NodeJS.ProcessEnv = process.env): string {
  return env.BRAINTRUST_GATEWAY_URL?.trim() || DEFAULT_BRAINTRUST_GATEWAY_URL;
}

export function resolveGatewayApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.BRAINTRUST_GATEWAY_API_KEY?.trim() || env.BRAINTRUST_API_KEY?.trim();
}

export function normalizeGatewayModelId(modelName: string): string {
  if (modelName.includes("/")) {
    const maybeModelId = modelName.split("/").at(-1)?.trim();
    if (maybeModelId) {
      return maybeModelId;
    }
  }

  return modelName;
}

export function getGoogleProvider(): GoogleGenerativeAIProvider {
  if (!googleProvider) {
    const apiKey = resolveGoogleApiKey();
    googleProvider = createGoogleGenerativeAI({ apiKey });
  }
  return googleProvider;
}

export function getGatewayProvider(baseURL: string, apiKey: string): OpenAIProvider {
  if (
    !gatewayProvider ||
    !cachedGatewayConfig ||
    cachedGatewayConfig.baseURL !== baseURL ||
    cachedGatewayConfig.apiKey !== apiKey
  ) {
    gatewayProvider = createOpenAI({
      baseURL,
      apiKey,
    });
    cachedGatewayConfig = { baseURL, apiKey };
  }
  return gatewayProvider;
}

export function getGatewayGoogleProvider(baseURL: string, apiKey: string): GoogleGenerativeAIProvider {
  if (
    !gatewayGoogleProvider ||
    !cachedGatewayGoogleConfig ||
    cachedGatewayGoogleConfig.baseURL !== baseURL ||
    cachedGatewayGoogleConfig.apiKey !== apiKey
  ) {
    gatewayGoogleProvider = createGoogleGenerativeAI({
      baseURL,
      apiKey,
      headers: {
        "x-api-key": apiKey,
      },
    });
    cachedGatewayGoogleConfig = { baseURL, apiKey };
  }
  return gatewayGoogleProvider;
}

export function googleModel(modelName: string) {
  if (!isGatewayEnabled()) {
    return getGoogleProvider()(modelName);
  }

  const apiKey = resolveGatewayApiKey();
  if (!apiKey) {
    throw new Error(
      "BRAINTRUST_USE_GATEWAY is enabled, but no gateway key is set. Set BRAINTRUST_GATEWAY_API_KEY or BRAINTRUST_API_KEY.",
    );
  }

  const baseURL = resolveGatewayBaseURL();
  const gatewayModelId = normalizeGatewayModelId(modelName);

  const usesGoogleModel = modelName.startsWith("google/") || !modelName.includes("/");
  if (usesGoogleModel) {
    return getGatewayGoogleProvider(baseURL, apiKey)(gatewayModelId);
  }

  return getGatewayProvider(baseURL, apiKey).chat(gatewayModelId);
}
