import { stepCountIs, tool } from "ai";
import { z } from "zod";

import { DEFAULT_MATH_AGENT_PROMPT } from "../config.js";
import { googleModel } from "../model.js";
import { MessageRecorder } from "../serializer.js";
import { getAISDK } from "../tracing.js";
import type { AgentRunResult } from "../types.js";

const UNIT_ALIASES: Record<string, string> = {
  j: "joule",
  joules: "joule",
  hp: "horsepower",
  "horsepower-seconds": "horsepower*second",
  "horsepower seconds": "horsepower*second",
  "horsepower-hours": "horsepower*hour",
  "horsepower hours": "horsepower*hour",
  "hp-s": "horsepower*second",
  "hp*s": "horsepower*second",
  "hp-hr": "horsepower*hour",
  "hp*h": "horsepower*hour",
};

const ENERGY_IN_JOULE: Record<string, number> = {
  joule: 1,
  "horsepower*second": 745.699872,
  "horsepower*hour": 745.699872 * 3600,
};

export function add(a: number, b: number): number {
  return a + b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}

export function divide(a: number, b: number): number {
  if (b === 0) {
    throw new Error("Cannot divide by zero.");
  }
  return a / b;
}

function normalizeUnit(unit: string): string {
  const lowered = unit.trim().toLowerCase();
  return UNIT_ALIASES[lowered] ?? lowered;
}

export function convertUnits(value: number, fromUnit: string, toUnit: string): number {
  const source = normalizeUnit(fromUnit);
  const target = normalizeUnit(toUnit);
  const sourceFactor = ENERGY_IN_JOULE[source];
  const targetFactor = ENERGY_IN_JOULE[target];

  if (!sourceFactor || !targetFactor) {
    throw new Error(`Unsupported unit conversion: ${fromUnit} -> ${toUnit}`);
  }

  const joules = value * sourceFactor;
  return joules / targetFactor;
}

export function isBasicMathOperation(operation: string): boolean {
  const normalized = operation.trim().toLowerCase();
  return ["add", "subtract", "multiply", "divide"].includes(normalized);
}

export function buildMathQuery(options: {
  operation: string;
  a?: number;
  b?: number;
  resultMode: "numeric" | "explanatory";
}): string {
  const { operation, a, b, resultMode } = options;

  if (isBasicMathOperation(operation)) {
    if (a === undefined || b === undefined) {
      throw new Error("Basic arithmetic operations require both a and b operands.");
    }

    if (resultMode === "numeric") {
      return `Use operation '${operation}' on the values a=${a} and b=${b}. Return the final numeric result.`;
    }

    return `Use operation '${operation}' on the values a=${a} and b=${b}. Explain the steps and include the final answer.`;
  }

  if (resultMode === "numeric") {
    return `Solve the following quantitative task and return the final numeric result only. Task: ${operation}`;
  }

  return `Solve the following math task and provide a concise explanation with the final answer. Task: ${operation}`;
}

export async function runMathAgent(options: {
  query: string;
  model?: string;
  systemPrompt?: string;
  requestResearchSubtask?: (query: string, maxResults?: number) => Promise<string>;
}): Promise<AgentRunResult> {
  const recorder = new MessageRecorder(options.query);
  const aiSdk = getAISDK();

  const tools: any = {
    add: tool({
      description: "Add two numbers and return their sum.",
      inputSchema: z.object({ a: z.number(), b: z.number() }),
      execute: async ({ a, b }: { a: number; b: number }) => {
        recorder.addToolCall("add", { a, b });
        const result = add(a, b);
        recorder.addToolResult(String(result));
        return result;
      },
    }),
    subtract: tool({
      description: "Subtract b from a and return the result.",
      inputSchema: z.object({ a: z.number(), b: z.number() }),
      execute: async ({ a, b }: { a: number; b: number }) => {
        recorder.addToolCall("subtract", { a, b });
        const result = subtract(a, b);
        recorder.addToolResult(String(result));
        return result;
      },
    }),
    multiply: tool({
      description: "Multiply two numbers and return the product.",
      inputSchema: z.object({ a: z.number(), b: z.number() }),
      execute: async ({ a, b }: { a: number; b: number }) => {
        recorder.addToolCall("multiply", { a, b });
        const result = multiply(a, b);
        recorder.addToolResult(String(result));
        return result;
      },
    }),
    divide: tool({
      description: "Divide a by b and return the quotient.",
      inputSchema: z.object({ a: z.number(), b: z.number() }),
      execute: async ({ a, b }: { a: number; b: number }) => {
        recorder.addToolCall("divide", { a, b });
        const result = divide(a, b);
        recorder.addToolResult(String(result));
        return result;
      },
    }),
    convert_units: tool({
      description: "Convert numeric values between compatible units.",
      inputSchema: z.object({
        value: z.number(),
        from_unit: z.string(),
        to_unit: z.string(),
      }),
      execute: async ({
        value,
        from_unit,
        to_unit,
      }: {
        value: number;
        from_unit: string;
        to_unit: string;
      }) => {
        recorder.addToolCall("convert_units", { value, from_unit, to_unit });
        const result = convertUnits(value, from_unit, to_unit);
        recorder.addToolResult(String(result));
        return result;
      },
    }),
  };

  if (options.requestResearchSubtask) {
    tools.request_research_subtask = tool({
      description: "Request a research subtask when factual lookup is required.",
      inputSchema: z.object({
        query: z.string(),
        max_results: z.number().int().min(1).max(5).default(3),
      }),
      execute: async ({ query, max_results }: { query: string; max_results: number }) => {
        recorder.addToolCall("request_research_subtask", { query, max_results });
        const result = await options.requestResearchSubtask!(query, max_results);
        recorder.addToolResult(result);
        return result;
      },
    });
  }

  const response = await aiSdk.generateText({
    model: googleModel(options.model ?? "gemini-2.0-flash-lite"),
    system: options.systemPrompt ?? DEFAULT_MATH_AGENT_PROMPT,
    prompt: options.query,
    tools,
    stopWhen: stepCountIs(4),
  });

  const finalOutput = (response.text ?? "").trim();
  recorder.addAssistantText(finalOutput);

  return {
    final_output: finalOutput,
    messages: recorder.toArray(),
  };
}
