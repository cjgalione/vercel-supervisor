import "dotenv/config";

import { Eval, loadParameters } from "braintrust";

import { runMathAgent } from "../src-ts/agents/math-agent.js";
import { extractFloatFromText } from "../src-ts/serializer.js";
import { configureTracing } from "../src-ts/tracing.js";
import type { SerializedMessage } from "../src-ts/types.js";
import type { supervisorEvalParameters } from "./eval-parameters-config.js";
import {
  EVAL_PARAMETERS_PROJECT_NAME,
  EVAL_PARAMETERS_SLUG,
  type EvalParameters,
  resolvePromptText,
} from "./parameters.js";

configureTracing({
  apiKey: process.env.BRAINTRUST_API_KEY,
  projectName: process.env.BRAINTRUST_PROJECT ?? "vercel-ai-sdk-supervisor",
  projectId: process.env.BRAINTRUST_PROJECT_ID,
});

type MathTaskInput = { query: string; expected_answer?: number };
type MathTaskOutput = { messages: SerializedMessage[] };

async function runMathTask(
  input: MathTaskInput,
  hooks: {
    parameters: Record<string, unknown>;
    metadata: Record<string, unknown>;
  },
): Promise<MathTaskOutput> {
  try {
    const parameters = hooks.parameters as Pick<EvalParameters, "math_agent_prompt" | "math_model">;
    const result = await runMathAgent({
      query: input.query,
      systemPrompt: resolvePromptText(parameters.math_agent_prompt),
      model: parameters.math_model,
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

async function registerMathEval(): Promise<void> {
  await Eval(process.env.BRAINTRUST_PROJECT ?? "vercel-ai-sdk-supervisor", {
    experimentName: "math-agent",
    data: MATH_TEST_DATA,
    task: runMathTask,
    scores: [calculationAccuracyScorer, toolUsageScorer, efficiencyScorer, responseFormatScorer],
    parameters: loadParameters<typeof supervisorEvalParameters>({
      projectName: process.env.BRAINTRUST_PROJECT ?? EVAL_PARAMETERS_PROJECT_NAME,
      slug: EVAL_PARAMETERS_SLUG,
    }),
  });
}

registerMathEval().catch((error) => {
  console.error("Failed to register math eval:", error);
  process.exitCode = 1;
});
