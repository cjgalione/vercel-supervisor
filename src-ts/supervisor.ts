import { stepCountIs, tool } from "ai";
import { z } from "zod";

import {
  DEFAULT_SUPERVISOR_MODEL,
  type AgentConfig,
  defaultAgentConfig,
  renderSupervisorPrompt,
} from "./config.js";
import { runCriticAgent, type CriticDecision } from "./agents/critic-agent.js";
import {
  buildMathQuery,
  isBasicMathOperation,
  runMathAgent,
  add,
  subtract,
  multiply,
  divide,
} from "./agents/math-agent.js";
import { runResearchAgent } from "./agents/research-agent.js";
import { openaiModel } from "./model.js";
import { MessageRecorder, extractFloatFromText, hasMarker } from "./serializer.js";
import { getAISDK, withSpan } from "./tracing.js";
import type { SerializedMessage, SupervisorRunResult } from "./types.js";

const CRITIC_ACTIONS: CriticDecision["required_action"][] = [
  "accept",
  "delegate_research",
  "delegate_math",
  "retry_with_instruction",
];

export type SupervisorHandle = {
  config: AgentConfig;
};

let cachedSupervisor: SupervisorHandle | null = null;

function queryNeedsMathHandoff(query: string): boolean {
  const lowered = query.toLowerCase();
  if (/\d/.test(lowered) && /(calculate|sum|add|subtract|multiply|divide|minus|plus|product|difference|percent|area|equation)/.test(lowered)) {
    return true;
  }
  return /\b\d+\s*[+\-*/]\s*\d+\b/.test(lowered);
}

function queryNeedsResearchHandoff(query: string): boolean {
  const lowered = query.toLowerCase();
  const keywordMatch = /(latest|current|who is|what is the capital|population|president|ceo|mayor|won|sources?|according to)/.test(lowered);
  const whMatch = /\b(who|what|when|where)\b/.test(lowered) && !queryNeedsMathHandoff(query);
  return keywordMatch || whMatch;
}

function fallbackCriticDecision(query: string, messages: SerializedMessage[]): CriticDecision {
  const needsMath = queryNeedsMathHandoff(query);
  const needsResearch = queryNeedsResearchHandoff(query);

  const hasMathHandoff = hasMarker(messages, [
    "delegate_to_math_agent",
    "request_math_subtask",
    "handoff [mathagent]",
  ]);
  const hasResearchHandoff = hasMarker(messages, [
    "delegate_to_research_agent",
    "request_research_subtask",
    "handoff [researchagent]",
  ]);
  const hasWebSearch = hasMarker(messages, ["tavily_search", "http://", "https://", "url:"]);

  if (needsMath && !hasMathHandoff) {
    return {
      compliant: false,
      required_action: "delegate_math",
      rationale: "Math-style query requires MathAgent delegation evidence.",
    };
  }

  if (needsResearch && (!hasResearchHandoff || !hasWebSearch)) {
    return {
      compliant: false,
      required_action: "delegate_research",
      rationale: "Research-style query requires ResearchAgent handoff and web-search evidence.",
    };
  }

  if ((needsMath || needsResearch) && !(hasMathHandoff || hasResearchHandoff)) {
    return {
      compliant: false,
      required_action: "retry_with_instruction",
      rationale: "Policy-triggering query was answered directly without delegation.",
    };
  }

  return {
    compliant: true,
    required_action: "accept",
    rationale: "Delegation/tool-use policy appears satisfied.",
  };
}

function normalizeCriticDecision(
  raw: Partial<CriticDecision>,
  query: string,
  messages: SerializedMessage[],
): CriticDecision {
  const fallback = fallbackCriticDecision(query, messages);

  if (typeof raw.compliant !== "boolean") {
    return fallback;
  }

  if (!raw.required_action || !CRITIC_ACTIONS.includes(raw.required_action)) {
    return fallback;
  }

  const normalized: CriticDecision = {
    compliant: raw.compliant,
    required_action: raw.required_action,
    rationale: raw.rationale?.trim() || fallback.rationale,
  };

  if (normalized.compliant && normalized.required_action !== "accept") {
    normalized.required_action = "accept";
  }

  if (!normalized.compliant && normalized.required_action === "accept") {
    normalized.required_action = "retry_with_instruction";
  }

  if (
    fallback.compliant !== normalized.compliant ||
    fallback.required_action !== normalized.required_action
  ) {
    return fallback;
  }

  return normalized;
}

function runBasicMath(operation: string, a: number, b: number): number {
  const normalized = operation.trim().toLowerCase();
  if (normalized === "add") {
    return add(a, b);
  }
  if (normalized === "subtract") {
    return subtract(a, b);
  }
  if (normalized === "multiply") {
    return multiply(a, b);
  }
  if (normalized === "divide") {
    return divide(a, b);
  }
  throw new Error(`Unsupported math operation: ${operation}`);
}

export function getSupervisor(options?: {
  config?: Partial<AgentConfig>;
  forceRebuild?: boolean;
}): SupervisorHandle {
  if (options?.config) {
    return { config: defaultAgentConfig(options.config) };
  }

  if (!cachedSupervisor || options?.forceRebuild) {
    cachedSupervisor = { config: defaultAgentConfig() };
  }

  return cachedSupervisor;
}

type MathHandoffResult = {
  final_output: string;
  parsed_result: number | null;
  returned_response: string;
  messages: SerializedMessage[];
};

export async function runSupervisorWithCritic(options: {
  supervisor: SupervisorHandle;
  query: string;
  appName: string;
}): Promise<SupervisorRunResult> {
  const config = options.supervisor.config;
  const aiSdk = getAISDK();
  const prompt = renderSupervisorPrompt(config);

  const runResearchHandoff = async (
    query: string,
    mode: string,
    appName: string,
  ): Promise<{ final_output: string; messages: SerializedMessage[] }> => {
    return withSpan(
      {
        name: "handoff [ResearchAgent]",
        type: "task",
        input: { query, mode, app_name: appName },
      },
      async (span) => {
        const result = await runResearchAgent({
          query,
          model: config.research_model,
          systemPrompt: config.research_agent_prompt,
          requestMathSubtask: async (operation: string, a: number, b: number) => {
            const math = await runMathHandoff({
              operation,
              a,
              b,
              resultMode: "numeric",
              mode: "subtask",
              appName: "vercel-ai-sdk-supervisor-math-subtask",
            });
            if (math.parsed_result === null) {
              throw new Error(`MathAgent did not return numeric result for operation '${operation}'.`);
            }
            return math.parsed_result;
          },
        });
        span.log({ output: { final_output: result.final_output } });
        return result;
      },
    );
  };

  const runMathHandoff = async (params: {
    mathTask?: string;
    operation?: string;
    a?: number;
    b?: number;
    resultMode: "numeric" | "explanatory";
    mode: string;
    appName: string;
  }): Promise<MathHandoffResult> => {
    const resolvedOperation = (params.mathTask ?? params.operation ?? "").trim();
    if (!resolvedOperation) {
      throw new Error("Provide a non-empty math task.");
    }

    const query = buildMathQuery({
      operation: resolvedOperation,
      a: params.a,
      b: params.b,
      resultMode: params.resultMode,
    });

    return withSpan(
      {
        name: "handoff [MathAgent]",
        type: "task",
        input: {
          math_task: resolvedOperation,
          mode: params.mode,
          a: params.a,
          b: params.b,
          result_mode: params.resultMode,
        },
      },
      async (span) => {
        const result = await runMathAgent({
          query,
          model: config.math_model,
          systemPrompt: config.math_agent_prompt,
          requestResearchSubtask: async (queryForResearch: string) => {
            const research = await runResearchHandoff(
              queryForResearch,
              "subtask",
              "vercel-ai-sdk-supervisor-research-subtask",
            );
            return research.final_output;
          },
        });

        const finalText = result.final_output.trim();
        let parsedResult = extractFloatFromText(finalText);

        if (params.resultMode === "numeric" && parsedResult === null && isBasicMathOperation(resolvedOperation)) {
          if (params.a === undefined || params.b === undefined) {
            throw new Error("Basic arithmetic operations require both a and b operands.");
          }
          parsedResult = runBasicMath(resolvedOperation, params.a, params.b);
        }

        if (params.resultMode === "numeric" && parsedResult === null && params.mode === "subtask") {
          throw new Error(
            `MathAgent did not return a numeric result for operation '${resolvedOperation}'. Model output: ${finalText}`,
          );
        }

        const returnedResponse =
          params.resultMode === "numeric"
            ? parsedResult !== null
              ? String(parsedResult)
              : finalText || "MathAgent returned no output."
            : finalText || (parsedResult !== null ? String(parsedResult) : "MathAgent returned no output.");

        span.log({
          output: {
            final_output: finalText,
            parsed_result: parsedResult,
            returned_response: returnedResponse,
          },
        });

        return {
          final_output: finalText,
          parsed_result: parsedResult,
          returned_response: returnedResponse,
          messages: result.messages,
        };
      },
    );
  };

  const runSupervisorCandidate = async (query: string, appName: string): Promise<{
    final_output: string;
    messages: SerializedMessage[];
  }> => {
    const recorder = new MessageRecorder(query);

    const response = await aiSdk.generateText({
      model: openaiModel(config.supervisor_model ?? DEFAULT_SUPERVISOR_MODEL),
      system: prompt,
      prompt: query,
      tools: {
        delegate_to_research_agent: tool({
          description: "Delegate a factual lookup or web-research task to ResearchAgent.",
          inputSchema: z.object({ query: z.string(), max_results: z.number().int().min(1).max(5).default(3) }),
          execute: async ({ query: toolQuery }) => {
            recorder.addToolCall("delegate_to_research_agent", { query: toolQuery });
            const handoff = await runResearchHandoff(
              toolQuery,
              "delegate",
              "vercel-ai-sdk-supervisor-delegate-research",
            );
            recorder.addMessages(handoff.messages);
            recorder.addToolResult(handoff.final_output);
            return handoff.final_output;
          },
        }),
        request_research_subtask: tool({
          description: "Request research before completing a downstream math subtask.",
          inputSchema: z.object({ query: z.string(), max_results: z.number().int().min(1).max(5).default(3) }),
          execute: async ({ query: toolQuery }) => {
            recorder.addToolCall("request_research_subtask", { query: toolQuery });
            const handoff = await runResearchHandoff(
              toolQuery,
              "subtask",
              "vercel-ai-sdk-supervisor-research-subtask",
            );
            recorder.addMessages(handoff.messages);
            recorder.addToolResult(handoff.final_output);
            return handoff.final_output;
          },
        }),
        delegate_to_math_agent: tool({
          description: "Delegate a math task to MathAgent.",
          inputSchema: z.object({
            math_task: z.string().optional(),
            operation: z.string().optional(),
            a: z.number().optional(),
            b: z.number().optional(),
            result_mode: z.enum(["numeric", "explanatory"]).default("explanatory"),
          }),
          execute: async ({ math_task, operation, a, b, result_mode }) => {
            recorder.addToolCall("delegate_to_math_agent", {
              math_task,
              operation,
              a,
              b,
              result_mode,
            });
            const handoff = await runMathHandoff({
              mathTask: math_task,
              operation,
              a,
              b,
              resultMode: result_mode,
              mode: "delegate",
              appName: "vercel-ai-sdk-supervisor-delegate-math",
            });
            recorder.addMessages(handoff.messages);
            recorder.addToolResult(handoff.returned_response);
            return handoff.returned_response;
          },
        }),
        request_math_subtask: tool({
          description: "Request a math subtask during compound research workflows.",
          inputSchema: z.object({ operation: z.string(), a: z.number(), b: z.number() }),
          execute: async ({ operation, a, b }) => {
            recorder.addToolCall("request_math_subtask", { operation, a, b });
            const handoff = await runMathHandoff({
              operation,
              a,
              b,
              resultMode: "numeric",
              mode: "subtask",
              appName: "vercel-ai-sdk-supervisor-math-subtask",
            });
            if (handoff.parsed_result === null) {
              throw new Error(`MathAgent did not return a numeric result for operation '${operation}'.`);
            }
            recorder.addMessages(handoff.messages);
            recorder.addToolResult(String(handoff.parsed_result));
            return handoff.parsed_result;
          },
        }),
      },
      stopWhen: stepCountIs(6),
    });

    const finalOutput = (response.text ?? "").trim();
    recorder.addAssistantText(finalOutput);

    return {
      final_output: finalOutput,
      messages: recorder.toArray(),
    };
  };

  const runCriticDecision = async (
    query: string,
    candidateOutput: string,
    messages: SerializedMessage[],
  ): Promise<CriticDecision> => {
    return withSpan(
      {
        name: "critic [CriticAgent]",
        type: "task",
        input: {
          query,
          candidate_final_output: candidateOutput,
          messages_summary: messages.slice(-14),
        },
      },
      async (span) => {
        const raw = await runCriticAgent({
          query,
          candidateFinalOutput: candidateOutput,
          messages,
          model: config.supervisor_model,
        });
        const decision = normalizeCriticDecision(raw, query, messages);
        span.log({ output: { decision } });
        return decision;
      },
    );
  };

  return withSpan(
    {
      name: "invocation [supervisor_with_critic]",
      type: "task",
      input: { query: options.query, app_name: options.appName },
    },
    async (rootSpan) => {
      const candidate = await runSupervisorCandidate(options.query, options.appName);
      let finalOutput = candidate.final_output;
      const messages = [...candidate.messages];

      let decision = await runCriticDecision(options.query, finalOutput, messages);
      messages.push({
        role: "system",
        content: `critic_decision: ${JSON.stringify(decision)}`,
        critic_decision: decision,
      });

      let corrected = false;

      if (!decision.compliant) {
        corrected = true;

        if (decision.required_action === "delegate_research") {
          const handoff = await runResearchHandoff(
            options.query,
            "critic_correction",
            "vercel-ai-sdk-supervisor-critic-delegate-research",
          );
          finalOutput = handoff.final_output.trim();
          messages.push(...handoff.messages);
          messages.push({ role: "system", content: "handoff marker: handoff [ResearchAgent]" });
        } else if (decision.required_action === "delegate_math") {
          const handoff = await runMathHandoff({
            mathTask: options.query,
            resultMode: "explanatory",
            mode: "critic_correction",
            appName: "vercel-ai-sdk-supervisor-critic-delegate-math",
          });
          finalOutput = handoff.returned_response.trim();
          messages.push(...handoff.messages);
          messages.push({ role: "system", content: "handoff marker: handoff [MathAgent]" });
        } else {
          const strictQuery = `POLICY ENFORCEMENT: You MUST delegate to the correct specialist agent(s) for this query and must not answer directly when delegation rules apply.\nOriginal query: ${options.query}`;
          const rerun = await runSupervisorCandidate(
            strictQuery,
            "vercel-ai-sdk-supervisor-critic-retry",
          );
          finalOutput = rerun.final_output.trim();
          messages.push(...rerun.messages);
        }

        decision = await runCriticDecision(options.query, finalOutput, messages);
        messages.push({
          role: "system",
          content: `critic_decision_retry: ${JSON.stringify(decision)}`,
          critic_decision: decision,
        });
      }

      if (finalOutput && !messages.some((message) => message.role === "assistant" && message.content.trim() === finalOutput)) {
        messages.push({ role: "assistant", content: finalOutput });
      }

      rootSpan.log({
        output: {
          final_output: finalOutput,
          critic_decision: decision,
          critic_corrected: corrected,
          num_messages: messages.length,
        },
      });

      return {
        final_output: finalOutput,
        messages,
        critic_decision: decision,
        critic_corrected: corrected,
      };
    },
  );
}

export async function runSupervisorWithConfig(options: {
  query: string;
  appName: string;
  config?: Partial<AgentConfig>;
}): Promise<SupervisorRunResult> {
  const supervisor = getSupervisor({ config: options.config, forceRebuild: true });
  return runSupervisorWithCritic({
    supervisor,
    query: options.query,
    appName: options.appName,
  });
}
