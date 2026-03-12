import assert from "node:assert/strict";
import test from "node:test";

import {
  isGatewayEnabled,
  normalizeGatewayModelId,
  resolveGatewayApiKey,
  resolveGatewayBaseURL,
} from "./model.js";

test("gateway flag parsing handles truthy values", () => {
  assert.equal(isGatewayEnabled({ BRAINTRUST_USE_GATEWAY: "true" }), true);
  assert.equal(isGatewayEnabled({ BRAINTRUST_USE_GATEWAY: "1" }), true);
  assert.equal(isGatewayEnabled({ BRAINTRUST_USE_GATEWAY: "yes" }), true);
  assert.equal(isGatewayEnabled({ BRAINTRUST_USE_GATEWAY: "on" }), true);
  assert.equal(isGatewayEnabled({ BRAINTRUST_USE_GATEWAY: "false" }), false);
  assert.equal(isGatewayEnabled({}), false);
});

test("gateway key resolution prefers explicit gateway key and falls back to Braintrust key", () => {
  assert.equal(
    resolveGatewayApiKey({
      BRAINTRUST_GATEWAY_API_KEY: "gw-key",
      BRAINTRUST_API_KEY: "bt-key",
    }),
    "gw-key",
  );
  assert.equal(resolveGatewayApiKey({ BRAINTRUST_API_KEY: "bt-key" }), "bt-key");
  assert.equal(resolveGatewayApiKey({}), undefined);
});

test("gateway base URL uses override when provided", () => {
  assert.equal(
    resolveGatewayBaseURL({ BRAINTRUST_GATEWAY_URL: "https://gateway.custom.example" }),
    "https://gateway.custom.example",
  );
  assert.equal(resolveGatewayBaseURL({}), "https://gateway.braintrust.dev");
});

test("gateway model normalization maps common provider prefixes", () => {
  assert.equal(normalizeGatewayModelId("gemini-2.0-flash-lite"), "gemini-2.0-flash-lite");
  assert.equal(normalizeGatewayModelId("claude-sonnet-4-5"), "claude-sonnet-4-5");
  assert.equal(normalizeGatewayModelId("gpt-4o-mini"), "gpt-4o-mini");
  assert.equal(normalizeGatewayModelId("openai/gpt-4o-mini"), "gpt-4o-mini");
  assert.equal(normalizeGatewayModelId("google/gemini-2.0-flash-lite"), "gemini-2.0-flash-lite");
  assert.equal(normalizeGatewayModelId("custom-model"), "custom-model");
});
