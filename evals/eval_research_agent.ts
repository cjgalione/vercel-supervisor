import "dotenv/config";

import { Eval } from "braintrust";
import { z } from "zod";

import { DEFAULT_RESEARCH_AGENT_PROMPT } from "../src-ts/config.js";
import { runResearchAgent } from "../src-ts/agents/research-agent.js";
import { configureTracing } from "../src-ts/tracing.js";
import type { SerializedMessage } from "../src-ts/types.js";

configureTracing({
  apiKey: process.env.BRAINTRUST_API_KEY,
  projectName: process.env.BRAINTRUST_PROJECT ?? "vercel-ai-sdk-supervisor",
  projectId: process.env.BRAINTRUST_PROJECT_ID,
});

const parameters = {
  research_agent_prompt: z.string().default(DEFAULT_RESEARCH_AGENT_PROMPT),
  research_model: z.string().default("gpt-4.1-mini"),
};

type ResearchTaskInput = { query: string };
type ResearchTaskOutput = { messages: SerializedMessage[] };

async function runResearchTask(input: ResearchTaskInput, hooks: { parameters: { research_agent_prompt: string; research_model: string }; metadata: Record<string, unknown> }): Promise<ResearchTaskOutput> {
  try {
    const result = await runResearchAgent({
      query: input.query,
      systemPrompt: hooks.parameters.research_agent_prompt,
      model: hooks.parameters.research_model,
    });

    const toolCalls = result.messages.flatMap((message) => message.tool_calls ?? []);
    hooks.metadata.tool_calls = toolCalls;
    hooks.metadata.used_web_search = toolCalls.some((toolCall) => toolCall.name === "tavily_search");
    hooks.metadata.total_messages = result.messages.length;

    return { messages: result.messages };
  } catch (error) {
    hooks.metadata.error = String(error);
    return { messages: [{ role: "system", content: `error: ${String(error)}` }] };
  }
}

const RESEARCH_TEST_DATA = [
  { input: { query: "Who is the current president of France?" }, metadata: {} },
  { input: { query: "What is the capital of Japan?" }, metadata: {} },
  { input: { query: "When was the Eiffel Tower built?" }, metadata: {} },
  { input: { query: "What are the main causes of climate change?" }, metadata: {} },
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

async function webSearchUsageScorer(args: { output: ResearchTaskOutput }) {
  const toolNames = args.output.messages.flatMap((message) => message.tool_calls ?? []).map((toolCall) => toolCall.name);
  return { name: "Web Search Usage", score: toolNames.includes("tavily_search") ? 1 : 0 };
}

async function sourceAttributionScorer(args: { output: ResearchTaskOutput }) {
  const answerText = latestAssistant(args.output.messages);
  return { name: "Source Attribution", score: /https?:\/\//.test(answerText) ? 1 : 0 };
}

async function efficiencyScorer(args: { output: ResearchTaskOutput }) {
  const numSearches = args.output.messages
    .flatMap((message) => message.tool_calls ?? [])
    .filter((toolCall) => toolCall.name === "tavily_search").length;

  if (numSearches === 1) {
    return { name: "Efficiency", score: 1 };
  }
  if (numSearches === 2) {
    return { name: "Efficiency", score: 0.9 };
  }
  if (numSearches <= 4) {
    return { name: "Efficiency", score: 0.7 };
  }
  return { name: "Efficiency", score: 0.5 };
}

async function answerQualityScorer(args: { output: ResearchTaskOutput }) {
  const answerText = latestAssistant(args.output.messages);
  const hasText = answerText.trim().length > 0;
  const hasSource = /https?:\/\//.test(answerText);
  const score = hasText ? (hasSource ? 1 : 0.7) : 0;
  return { name: "Answer Quality", score };
}

await Eval(process.env.BRAINTRUST_PROJECT ?? "vercel-ai-sdk-supervisor", {
  experimentName: "research-agent",
  data: RESEARCH_TEST_DATA,
  task: runResearchTask,
  scores: [webSearchUsageScorer, sourceAttributionScorer, efficiencyScorer, answerQualityScorer],
  parameters,
});
