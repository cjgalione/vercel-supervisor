import { stepCountIs, tool } from "ai";
import { z } from "zod";

import { DEFAULT_RESEARCH_AGENT_PROMPT } from "../config.js";
import { openaiModel } from "../model.js";
import { MessageRecorder } from "../serializer.js";
import { getAISDK } from "../tracing.js";
import type { AgentRunResult } from "../types.js";

type SearchProvider = "exa" | "tavily" | "you";

function getTavilyApiKey(): string {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new Error("TAVILY_API_KEY is not set");
  }
  return apiKey;
}

function getExaApiKey(): string {
  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey) {
    throw new Error("EXA_API_KEY is not set");
  }
  return apiKey;
}

function getYouApiKey(): string {
  for (const envName of ["YDC_API_KEY", "YOU_API_KEY", "YOUCOM_API_KEY"]) {
    const apiKey = process.env[envName];
    if (apiKey) {
      return apiKey;
    }
  }
  throw new Error("YDC_API_KEY is not set");
}

function hasProviderKey(provider: SearchProvider): boolean {
  if (provider === "exa") {
    return Boolean(process.env.EXA_API_KEY);
  }
  if (provider === "tavily") {
    return Boolean(process.env.TAVILY_API_KEY);
  }
  return Boolean(process.env.YDC_API_KEY || process.env.YOU_API_KEY || process.env.YOUCOM_API_KEY);
}

function normalizeSearchProvider(provider: string | undefined): SearchProvider {
  const normalized = (provider || "exa").trim().toLowerCase().replace("_", "-");
  if (normalized === "you.com" || normalized === "youcom" || normalized === "ydc") {
    return "you";
  }
  if (normalized === "tavily" || normalized === "you" || normalized === "exa") {
    return normalized;
  }
  return "exa";
}

function searchProviderOrder(): SearchProvider[] {
  const preferred = normalizeSearchProvider(
    process.env.SEARCH_PROVIDER || process.env.WEB_SEARCH_PROVIDER,
  );
  const providers: SearchProvider[] = ["exa", "tavily", "you"];
  const ordered: SearchProvider[] = [preferred];
  for (const provider of providers) {
    if (!ordered.includes(provider) && hasProviderKey(provider)) {
      ordered.push(provider);
    }
  }
  return ordered;
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

async function exaSearch(query: string, maxResults: number): Promise<string> {
  const response = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": getExaApiKey(),
    },
    body: JSON.stringify({
      query,
      type: "auto",
      numResults: Math.max(1, Math.min(maxResults, 5)),
      contents: { highlights: true },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Exa search failed: ${response.status} ${body}`);
  }

  const data = (await response.json()) as {
    results?: Array<{
      title?: string;
      url?: string;
      highlights?: string[] | string;
      summary?: string;
      text?: string;
    }>;
  };

  const results = data.results ?? [];
  if (results.length === 0) {
    return "No search results found.";
  }

  return results
    .slice(0, maxResults)
    .map((item, index) => {
      const highlights = Array.isArray(item.highlights)
        ? item.highlights.filter(Boolean).join(" ")
        : item.highlights;
      const content = highlights || item.summary || item.text?.slice(0, 800) || "N/A";
      return `${index + 1}. ${item.title?.trim() || "Untitled"}\nURL: ${
        item.url?.trim() || "N/A"
      }\nSummary: ${content}`;
    })
    .join("\n\n");
}

async function youSearch(query: string, maxResults: number): Promise<string> {
  const url = new URL("https://ydc-index.io/v1/search");
  url.searchParams.set("query", query);
  url.searchParams.set("count", String(Math.max(1, Math.min(maxResults, 5))));

  const response = await fetch(url, {
    headers: {
      "X-API-Key": getYouApiKey(),
      "User-Agent": "supervisor-demos/1.0",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`You.com search failed: ${response.status} ${body}`);
  }

  const data = (await response.json()) as {
    results?: {
      web?: Array<{
        title?: string;
        url?: string;
        description?: string;
        snippets?: string[] | string;
      }>;
      news?: Array<{
        title?: string;
        url?: string;
        description?: string;
        snippets?: string[] | string;
      }>;
    };
  };

  const results = [
    ...(data.results?.web ?? []).map((item) => ({ type: "web", item })),
    ...(data.results?.news ?? []).map((item) => ({ type: "news", item })),
  ];

  if (results.length === 0) {
    return "No search results found.";
  }

  return results
    .slice(0, maxResults)
    .map(({ type, item }, index) => {
      const snippets = Array.isArray(item.snippets)
        ? item.snippets.filter(Boolean).slice(0, 2).join(" ")
        : item.snippets;
      const content = snippets || item.description || "N/A";
      return `${index + 1}. ${item.title?.trim() || "Untitled"}\nURL: ${
        item.url?.trim() || "N/A"
      }\nSource: You.com ${type}\nSummary: ${content}`;
    })
    .join("\n\n");
}

async function searchWithProvider(
  provider: SearchProvider,
  query: string,
  maxResults: number,
): Promise<string> {
  if (provider === "exa") {
    return exaSearch(query, maxResults);
  }
  if (provider === "tavily") {
    return tavilySearch(query, maxResults);
  }
  return youSearch(query, maxResults);
}

async function webSearch(query: string, maxResults: number): Promise<string> {
  const errors: string[] = [];
  for (const provider of searchProviderOrder()) {
    try {
      return await searchWithProvider(provider, query, maxResults);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${provider}: ${message}`);
    }
  }
  throw new Error(`Web search failed for configured providers: ${errors.join("; ")}`);
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
        const result = await webSearch(query, max_results);
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
    model: openaiModel(options.model ?? "gpt-4.1-mini"),
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
