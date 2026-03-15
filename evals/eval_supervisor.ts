import "dotenv/config";

import { readFileSync } from "node:fs";
import path from "node:path";

import { Eval, initDataset, initFunction, loadParameters } from "braintrust";

import type { AgentConfig } from "../src-ts/config.js";
import { extractQueryFromInput, inferAgentsFromMessages } from "../src-ts/eval_helpers.js";
import { hasMarker } from "../src-ts/serializer.js";
import { configureTracing } from "../src-ts/tracing.js";
import { getSupervisor, runSupervisorWithCritic } from "../src-ts/supervisor.js";
import type { SerializedMessage } from "../src-ts/types.js";
import type { supervisorEvalParameters } from "./eval-parameters-config.js";
import {
  EVAL_PARAMETERS_PROJECT_NAME,
  EVAL_PARAMETERS_SLUG,
  type EvalParameters,
} from "./parameters.js";

const projectRoot = path.resolve(process.cwd());

const DEFAULT_BRAINTRUST_PROJECT = "vercel-ai-sdk-supervisor";
const DEFAULT_BRAINTRUST_DATASET = "Google ADK Supervisor Dataset";

configureTracing({
  apiKey: process.env.BRAINTRUST_API_KEY,
  projectName: process.env.BRAINTRUST_PROJECT ?? DEFAULT_BRAINTRUST_PROJECT,
  projectId: process.env.BRAINTRUST_PROJECT_ID,
});

function loadLocalDataset(): Array<{ input: Record<string, unknown>; metadata: Record<string, unknown> }> {
  const datasetPath = path.join(projectRoot, "dataset.jsonl");
  const lines = readFileSync(datasetPath, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const rows = lines.map((line) => {
    const parsed = JSON.parse(line) as { input: Record<string, unknown>; metadata?: Record<string, unknown> };
    return { input: parsed.input, metadata: parsed.metadata ?? {} };
  });

  const limitRaw = process.env.TS_EVAL_LIMIT ?? process.env.EVAL_LIMIT;
  const limit = limitRaw ? Math.max(1, Number.parseInt(limitRaw, 10)) : null;
  const limitedRows = Number.isFinite(limit) && limit !== null ? rows.slice(0, limit) : rows;

  limitedRows.push({
    input: {
      messages: [
        {
          content: "Calculate 341 * 29. Do not answer directly without delegating to MathAgent.",
          type: "human",
        },
      ],
    },
    metadata: {},
  });

  return limitedRows;
}

function queryRequiresMathHandoff(query: string): boolean {
  const lowered = query.toLowerCase();
  if (/\b\d+\s*[+\-*/]\s*\d+\b/.test(lowered)) {
    return true;
  }
  return /\d/.test(lowered) && /(calculate|add|subtract|multiply|divide|sum|difference|product|square root|percent|minus|plus|area)/.test(lowered);
}

function queryRequiresResearchHandoff(query: string): boolean {
  const lowered = query.toLowerCase();
  if (/(latest|current|who is|what is the capital|population|president|ceo|mayor|won|source|sources)/.test(lowered)) {
    return true;
  }
  return /\b(who|what|when|where)\b/.test(lowered) && !queryRequiresMathHandoff(query);
}

function outputMessages(output: Record<string, unknown>): SerializedMessage[] {
  const messages = output.messages;
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages.filter((message): message is SerializedMessage => {
    return typeof message === "object" && message !== null && "role" in message && "content" in message;
  });
}

async function runSupervisorTask(input: Record<string, unknown>, hooks: { parameters: EvalParameters; metadata: Record<string, unknown> }): Promise<{ final_output: string; messages: SerializedMessage[] }> {
  try {
    const config = hooks.parameters as Partial<AgentConfig>;
    const supervisor = getSupervisor({ config, forceRebuild: true });
    const query = extractQueryFromInput(input);

    const result = await runSupervisorWithCritic({
      supervisor,
      query,
      appName: "google-adk-supervisor-eval-supervisor",
    });

    hooks.metadata.final_output = result.final_output;
    hooks.metadata.num_messages = result.messages.length;

    return { final_output: result.final_output, messages: result.messages };
  } catch (error) {
    hooks.metadata.error = String(error);
    return {
      final_output: "",
      messages: [{ role: "system", content: `error: ${String(error)}` }],
    };
  }
}

async function delegationComplianceScorer(args: {
  input: Record<string, unknown>;
  output: Record<string, unknown>;
}) {
  const query = extractQueryFromInput(args.input);
  const messages = outputMessages(args.output);

  const requiresMath = queryRequiresMathHandoff(query);
  const requiresResearch = queryRequiresResearchHandoff(query);

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
  const hasWebMarker = hasMarker(messages, ["tavily_search", "http://", "https://", "url:"]);

  const compliant = (!requiresMath || hasMathHandoff) && (!requiresResearch || (hasResearchHandoff && hasWebMarker));

  return {
    name: "Delegation Compliance",
    score: compliant ? 1 : 0,
    metadata: {
      query,
      requires_math_handoff: requiresMath,
      requires_research_handoff: requiresResearch,
      has_math_handoff: hasMathHandoff,
      has_research_handoff: hasResearchHandoff,
      has_web_marker: hasWebMarker,
    },
  };
}

async function routingAccuracyScorer(args: {
  input: Record<string, unknown>;
  output: Record<string, unknown>;
}) {
  const query = extractQueryFromInput(args.input);
  const messages = outputMessages(args.output);
  const agentsCalled = inferAgentsFromMessages(messages);

  const requiresMath = queryRequiresMathHandoff(query);
  const requiresResearch = queryRequiresResearchHandoff(query);

  const hasMath = agentsCalled.includes("MathAgent");
  const hasResearch = agentsCalled.includes("ResearchAgent");

  let choice: "A" | "B" | "C" | "D" = "D";
  if ((!requiresMath || hasMath) && (!requiresResearch || hasResearch)) {
    choice = "A";
  } else if ((requiresMath && hasMath) || (requiresResearch && hasResearch)) {
    choice = "B";
  } else if (hasMath || hasResearch) {
    choice = "C";
  }

  const scoreMap: Record<typeof choice, number> = {
    A: 1,
    B: 0.7,
    C: 0.3,
    D: 0,
  };

  return {
    name: "Routing Accuracy",
    score: scoreMap[choice],
    metadata: {
      choice,
      agents_called: agentsCalled.join(", ") || "None",
      query,
    },
  };
}

function latestAssistantText(output: Record<string, unknown>): string {
  const messages = outputMessages(output);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant" && message.content.trim()) {
      return message.content;
    }
  }
  return "";
}

function isSelfContainedMathQuery(query: string): boolean {
  const lowered = query.toLowerCase();
  if (lowered.includes("derivative") && /derivative\s+of\s+.+/.test(lowered)) {
    return true;
  }
  if (lowered.includes("integral") && /integral\s+of\s+.+/.test(lowered)) {
    return true;
  }
  if (lowered.includes("solve for") && lowered.includes("=")) {
    return true;
  }
  return false;
}

function looksLikeClarificationRequest(text: string): boolean {
  const lowered = text.toLowerCase();
  return /(i need|need more information|could you provide|please provide|could you clarify)/.test(lowered);
}

async function noUnnecessaryClarificationScorer(args: {
  input: Record<string, unknown>;
  output: Record<string, unknown>;
}) {
  const query = extractQueryFromInput(args.input);
  const assistantText = latestAssistantText(args.output);
  const badCase = isSelfContainedMathQuery(query) && looksLikeClarificationRequest(assistantText);

  return {
    name: "No Unnecessary Clarification",
    score: badCase ? 0 : 1,
    metadata: {
      self_contained_math_query: isSelfContainedMathQuery(query),
      asked_for_clarification: looksLikeClarificationRequest(assistantText),
      query,
      assistant_response: assistantText,
    },
  };
}

async function responseQualityScorer(args: {
  input: Record<string, unknown>;
  output: Record<string, unknown>;
}) {
  const query = extractQueryFromInput(args.input);
  const answer = latestAssistantText(args.output);
  const hasContent = answer.trim().length > 0;
  const hasNumber = /\d/.test(answer);
  const needsMath = queryRequiresMathHandoff(query);
  const score = hasContent ? (needsMath && !hasNumber ? 0.5 : 0.8) : 0;

  return {
    name: "Response Quality",
    score,
    metadata: {
      has_content: hasContent,
      has_number: hasNumber,
      query,
    },
  };
}

async function stepEfficiencyScorer(args: { output: Record<string, unknown> }) {
  const messages = outputMessages(args.output);
  const maxSteps = 8;
  const numSteps = messages.length;
  const score = numSteps <= maxSteps ? 1 : Math.max(0, 1 - (numSteps - maxSteps) / maxSteps);

  return {
    name: "Step Efficiency",
    score,
    metadata: { num_steps: numSteps, max_steps: maxSteps },
  };
}

const projectName = process.env.BRAINTRUST_PROJECT ?? DEFAULT_BRAINTRUST_PROJECT;
const usePublishedStepScorer = ["1", "true", "yes"].includes(
  (process.env.USE_PUBLISHED_STEP_SCORER ?? "1").toLowerCase(),
);

const stepEfficiencyScore = usePublishedStepScorer
  ? initFunction({ projectName, slug: "step-efficiency" })
  : stepEfficiencyScorer;

const useRemoteDataset = ["1", "true", "yes"].includes(
  (process.env.BRAINTRUST_USE_REMOTE_DATASET ?? "0").toLowerCase(),
);

const data = useRemoteDataset
  ? initDataset(projectName, {
      dataset: process.env.BRAINTRUST_DATASET ?? DEFAULT_BRAINTRUST_DATASET,
    })
  : loadLocalDataset();

async function registerSupervisorEval(): Promise<void> {
  await Eval(projectName, {
    data,
    task: runSupervisorTask,
    scores: [
      responseQualityScorer,
      noUnnecessaryClarificationScorer,
      routingAccuracyScorer,
      delegationComplianceScorer,
      stepEfficiencyScore,
    ],
    parameters: loadParameters<typeof supervisorEvalParameters>({
      projectName: process.env.BRAINTRUST_PROJECT ?? EVAL_PARAMETERS_PROJECT_NAME,
      slug: EVAL_PARAMETERS_SLUG,
    }),
  });
}

registerSupervisorEval().catch((error) => {
  console.error("Failed to register supervisor eval:", error);
  process.exitCode = 1;
});
