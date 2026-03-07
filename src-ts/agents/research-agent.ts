import { stepCountIs, tool } from "ai";
import { z } from "zod";

import { DEFAULT_RESEARCH_AGENT_PROMPT } from "../config.js";
import { googleModel } from "../model.js";
import { MessageRecorder } from "../serializer.js";
import { getAISDK } from "../tracing.js";
import type { AgentRunResult } from "../types.js";

function getTavilyApiKey(): string {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new Error("TAVILY_API_KEY is not set");
  }
  return apiKey;
}

async function tavilySearch(query: string, maxResults: number): Promise<string> {
  const payload = {
    api_key: getTavilyApiKey(),
    query,
    max_results: Math.max(1, Math.min(maxResults, 5)),
    include_answer: true,
    include_raw_content: false,
  };

  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Tavily search failed: ${response.status} ${body}`);
  }

  const data = (await response.json()) as {
    answer?: string;
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };

  const lines: string[] = [];
  if (data.answer) {
    lines.push(`Answer: ${data.answer}`);
  }

  const results = data.results ?? [];
  if (results.length === 0) {
    return lines.length > 0 ? lines.join("\n\n") : "No search results found.";
  }

  for (let index = 0; index < results.length; index += 1) {
    const item = results[index];
    lines.push(
      `${index + 1}. ${item.title?.trim() || "Untitled"}\nURL: ${item.url?.trim() || "N/A"}\nSummary: ${
        item.content?.trim() || "N/A"
      }`,
    );
  }

  return lines.join("\n\n");
}

export async function runResearchAgent(options: {
  query: string;
  model?: string;
  systemPrompt?: string;
  requestMathSubtask?: (operation: string, a: number, b: number) => Promise<number>;
}): Promise<AgentRunResult> {
  const recorder = new MessageRecorder(options.query);
  const aiSdk = getAISDK();

  const tools: any = {
    tavily_search: tool({
      description: "Search the web with Tavily and return summarized results with links.",
      inputSchema: z.object({
        query: z.string(),
        max_results: z.number().int().min(1).max(5).default(3),
      }),
      execute: async ({ query, max_results }: { query: string; max_results: number }) => {
        recorder.addToolCall("tavily_search", { query, max_results });
        const result = await tavilySearch(query, max_results);
        recorder.addToolResult(result);
        return result;
      },
    }),
  };

  if (options.requestMathSubtask) {
    tools.request_math_subtask = tool({
      description:
        "Request a math subtask during compound research workflows. Returns numeric result.",
      inputSchema: z.object({
        operation: z.string(),
        a: z.number(),
        b: z.number(),
      }),
      execute: async ({
        operation,
        a,
        b,
      }: {
        operation: string;
        a: number;
        b: number;
      }) => {
        recorder.addToolCall("request_math_subtask", { operation, a, b });
        const result = await options.requestMathSubtask!(operation, a, b);
        recorder.addToolResult(String(result));
        return result;
      },
    });
  }

  const response = await aiSdk.generateText({
    model: googleModel(options.model ?? "gemini-2.0-flash-lite"),
    system: options.systemPrompt ?? DEFAULT_RESEARCH_AGENT_PROMPT,
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
