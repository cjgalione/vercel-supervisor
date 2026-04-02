import "dotenv/config";

import { Eval } from "braintrust";
import { z } from "zod";

import { DEFAULT_MATH_AGENT_PROMPT } from "../src-ts/config.js";
import { runMathAgent } from "../src-ts/agents/math-agent.js";
import { extractFloatFromText } from "../src-ts/serializer.js";
import { configureTracing } from "../src-ts/tracing.js";
import type { SerializedMessage } from "../src-ts/types.js";

configureTracing({
  apiKey: process.env.BRAINTRUST_API_KEY,
  projectName: process.env.BRAINTRUST_PROJECT ?? "vercel-ai-sdk-supervisor",
  projectId: process.env.BRAINTRUST_PROJECT_ID,
});

const parameters = {
  math_agent_prompt: z.string().default(DEFAULT_MATH_AGENT_PROMPT),
  math_model: z.string().default("gpt-4.1-mini"),
};

type MathTaskInput = { query: string; expected_answer?: number };
type MathTaskOutput = { messages: SerializedMessage[] };

async function runMathTask(input: MathTaskInput, hooks: { parameters: { math_agent_prompt: string; math_model: string }; metadata: Record<string, unknown> }): Promise<MathTaskOutput> {
  try {
    const result = await runMathAgent({
      query: input.query,
      systemPrompt: hooks.parameters.math_agent_prompt,
      model: hooks.parameters.math_model,
    });

    const toolCalls = result.messages.flatMap((message) => message.tool_calls ?? []);
    hooks.metadata.tool_calls = toolCalls;
    hooks.metadata.total_messages = result.messages.length;

    return { messages: result.messages };
  } catch (error) {
    hooks.metadata.error = String(error);
    return { messages: [{ role: "system", content: `error: ${String(error)}` }] };
  }
}

const MATH_TEST_DATA: Array<{
  input: MathTaskInput;
  expected: { expected_answer: number };
  metadata: Record<string, unknown>;
}> = [
  { input: { query: "What is 25 + 17?" }, expected: { expected_answer: 42 }, metadata: {} },
  { input: { query: "Calculate 100 - 37" }, expected: { expected_answer: 63 }, metadata: {} },
  { input: { query: "What is 12 * 8?" }, expected: { expected_answer: 96 }, metadata: {} },
  { input: { query: "Divide 144 by 12" }, expected: { expected_answer: 12 }, metadata: {} },
  { input: { query: "What's 15 * 7 + 3?" }, expected: { expected_answer: 108 }, metadata: {} },
  { input: { query: "Calculate (50 + 30) / 4" }, expected: { expected_answer: 20 }, metadata: {} },
];

function latestAssistant(messages: SerializedMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant" && message.content.trim()) {
      return message.content;
    }
  }
  return "";
}

async function calculationAccuracyScorer(args: {
  output: MathTaskOutput;
  expected: { expected_answer: number };
}) {
  const answerText = latestAssistant(args.output.messages);
  const parsed = extractFloatFromText(answerText);
  const expected = args.expected.expected_answer;

  if (parsed === null) {
    return { name: "Calculation Accuracy", score: 0 };
  }

  const score = Math.abs(parsed - expected) < 1e-6 ? 1 : 0;
  return { name: "Calculation Accuracy", score };
}

async function toolUsageScorer(args: { output: MathTaskOutput }) {
  const toolNames = args.output.messages
    .flatMap((message) => message.tool_calls ?? [])
    .map((toolCall) => toolCall.name);

  const validTools = new Set(["add", "subtract", "multiply", "divide"]);
  const usedValidTools = toolNames.some((name) => validTools.has(name));
  return { name: "Tool Usage", score: usedValidTools ? 1 : 0 };
}

async function efficiencyScorer(args: { output: MathTaskOutput }) {
  const numCalls = args.output.messages.flatMap((message) => message.tool_calls ?? []).length;
  if (numCalls <= 2) {
    return { name: "Efficiency", score: 1 };
  }
  if (numCalls <= 4) {
    return { name: "Efficiency", score: 0.8 };
  }
  if (numCalls <= 6) {
    return { name: "Efficiency", score: 0.6 };
  }
  return { name: "Efficiency", score: 0.4 };
}

async function responseFormatScorer(args: { output: MathTaskOutput }) {
  const answerText = latestAssistant(args.output.messages);
  return { name: "Response Format", score: /\d/.test(answerText) ? 1 : 0 };
}

await Eval(process.env.BRAINTRUST_PROJECT ?? "vercel-ai-sdk-supervisor", {
  experimentName: "math-agent",
  data: MATH_TEST_DATA,
  task: runMathTask,
  scores: [calculationAccuracyScorer, toolUsageScorer, efficiencyScorer, responseFormatScorer],
  parameters,
});
