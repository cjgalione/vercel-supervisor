import assert from "node:assert/strict";
import test from "node:test";

import { preflightFailureCategory } from "../scripts/run_queries.js";

test("preflight classifies invalid credentials without exposing their value", () => {
  const secret = "sk-test-secret";
  assert.equal(preflightFailureCategory(new Error(`Incorrect API key provided: ${secret}`)), "authentication");
});

test("preflight classifies quota and transient failures", () => {
  assert.equal(preflightFailureCategory(new Error("insufficient_quota")), "quota");
  assert.equal(preflightFailureCategory(new Error("connection timed out")), "transient");
});
