#!/usr/bin/env node
import "dotenv/config";

import { parseArgs } from "node:util";

import { defaultAgentConfig } from "../src-ts/config.js";
import { openaiModel } from "../src-ts/model.js";
import { configureTracing, flushTracing, getAISDK, validateBraintrustAccess } from "../src-ts/tracing.js";
import { getSupervisor, runSupervisorWithCritic } from "../src-ts/supervisor.js";

const DEFAULT_BRAINTRUST_PROJECT = "vercel-ai-sdk-supervisor";
const MODEL_POOL = ["gpt-4.1-mini"];
const QUESTION_GENERATOR_MODEL = "gpt-4.1-mini";

const QUESTION_BANK = [
  "What is 37 * 24?",
  "Who won the first modern Olympic Games and in what year?",
  "If a supernova releases 10^44 joules, how many 60W lightbulb-hours is that?",
  "What's the capital of Japan and what is 18% of 250?",
  "Hey, can you help me quickly estimate 15% tip on $86.40?",
  "When was the Eiffel Tower completed?",
  "Compute (1250 / 5) - 73.",
  "I'm frustrated. Just tell me if 144 divided by 12 is actually 11 or 12.",
  "What is the population of Canada and what is 2% of that number?",
  "Convert 10^6 joules to horsepower-seconds.",
  "What is the square root of 2025?",
  "Can you summarize what a quasar is in one sentence?",
  "If GDP is $2.1T and growth is 3.2%, what is the increase?",
  "Who discovered penicillin and in what year?",
  "What is (48 + 72) / 6?",
];

function isResourceExhaustedError(error: unknown): boolean {
  const text = String(error).toLowerCase();
  return text.includes("resource_exhausted") || text.includes("quota") || text.includes("429");
}

function isHardQuotaExhausted(error: unknown): boolean {
  const text = String(error).toLowerCase();
  return text.includes("insufficient_quota") || text.includes("exceeded your current quota");
}

function retryDelaySeconds(error: unknown): number | null {
  const text = String(error);
  const retry = text.match(/Please retry in ([0-9]+(?:\.[0-9]+)?)s/i);
  if (retry) {
    return Number(retry[1]);
  }

  const alt = text.match(/'retryDelay': '([0-9]+)s'/i);
  if (alt) {
    return Number(alt[1]);
  }

  return null;
}

function fallbackQuestions(numQuestions: number, seed?: number): string[] {
  const questions = [...QUESTION_BANK];
  const out: string[] = [];

  let state = seed ?? Date.now();
  const random = () => {
    state = (state * 1103515245 + 12345) % 2_147_483_647;
    return state / 2_147_483_647;
  };

  while (out.length < numQuestions) {
    for (let index = questions.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(random() * (index + 1));
      [questions[index], questions[swapIndex]] = [questions[swapIndex], questions[index]];
    }
    out.push(...questions.slice(0, Math.min(numQuestions - out.length, questions.length)));
  }

  return out;
}

async function generateQuestions(numQuestions: number, seed?: number): Promise<string[]> {
  const aiSdk = getAISDK();

  try {
    const response = await aiSdk.generateText({
      model: openaiModel(QUESTION_GENERATOR_MODEL),
      prompt: `Generate exactly ${numQuestions} realistic user questions that test an AI multi-agent system.
Create a diverse mix of pure math, pure research, hybrid, and edge-case conversational questions.
Return only a valid JSON array of strings, no markdown, no explanation, each question <200 chars.`,
    });

    const parsed = JSON.parse((response.text ?? "").trim());
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
      throw new Error("Question generator did not return a JSON array of strings.");
    }

    return parsed.slice(0, numQuestions);
  } catch {
    return fallbackQuestions(numQuestions, seed);
  }
}

async function quotaPreflightOk(): Promise<{ ok: boolean; reason: string }> {
  const aiSdk = getAISDK();
  try {
    await aiSdk.generateText({
      model: openaiModel(QUESTION_GENERATOR_MODEL),
      prompt: "Reply with exactly: OK",
    });
    return { ok: true, reason: "" };
  } catch (error) {
    if (isHardQuotaExhausted(error)) {
      return { ok: false, reason: String(error) };
    }
    return { ok: true, reason: "" };
  }
}

async function runQuestion(options: {
  question: string;
  maxRetries: number;
  baseRetrySeconds: number;
}): Promise<{ ok: boolean; hardStop: boolean }> {
  const selectedModel = MODEL_POOL[Math.floor(Math.random() * MODEL_POOL.length)];
  const supervisor = getSupervisor({
    config: defaultAgentConfig({
      supervisor_model: selectedModel,
      research_model: selectedModel,
      math_model: selectedModel,
    }),
    forceRebuild: true,
  });

  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      const result = await runSupervisorWithCritic({
        supervisor,
        query: options.question,
        appName: "vercel-ai-sdk-supervisor-batch",
      });
      console.log(`✅ ${options.question.slice(0, 80)} -> ${result.final_output.slice(0, 80)}`);
      return { ok: true, hardStop: false };
    } catch (error) {
      if (!isResourceExhaustedError(error)) {
        console.log(`❌ ${options.question.slice(0, 80)} -> ${String(error)}`);
        return { ok: false, hardStop: false };
      }

      if (isHardQuotaExhausted(error)) {
        console.log(`⏹️ ${options.question.slice(0, 80)} -> hard quota exhausted (${String(error)})`);
        return { ok: false, hardStop: true };
      }

      if (attempt > options.maxRetries) {
        console.log(`❌ ${options.question.slice(0, 80)} -> exhausted retries (${String(error)})`);
        return { ok: false, hardStop: false };
      }

      const suggested = retryDelaySeconds(error) ?? 0;
      const backoff = options.baseRetrySeconds * 2 ** (attempt - 1);
      const sleepSeconds = Math.max(suggested, backoff);
      console.log(`⏳ ${options.question.slice(0, 80)} -> retrying in ${sleepSeconds.toFixed(1)}s`);
      await new Promise((resolve) => setTimeout(resolve, sleepSeconds * 1000));
    }
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      concurrency: { type: "string", default: process.env.CONCURRENCY ?? "1" },
      seed: { type: "string" },
      "num-questions": { type: "string" },
      "fail-on-error": { type: "boolean", default: false },
      "max-retries": { type: "string", default: process.env.MAX_RETRIES ?? "3" },
      "base-retry-seconds": { type: "string", default: process.env.BASE_RETRY_SECONDS ?? "15" },
      "inter-question-delay-seconds": {
        type: "string",
        default: process.env.INTER_QUESTION_DELAY_SECONDS ?? "2",
      },
      "quota-preflight": { type: "boolean", default: (process.env.QUOTA_PREFLIGHT ?? "1") !== "0" },
      "require-braintrust": { type: "boolean", default: (process.env.REQUIRE_BRAINTRUST ?? "0") === "1" },
    },
  });

  const numQuestions = values["num-questions"] ? Number(values["num-questions"]) : Math.floor(Math.random() * 100) + 1;
  const concurrency = Math.max(1, Number(values.concurrency));
  const seed = values.seed ? Number(values.seed) : undefined;
  const maxRetries = Math.max(0, Number(values["max-retries"]));
  const baseRetrySeconds = Number(values["base-retry-seconds"]);
  const interQuestionDelaySeconds = Number(values["inter-question-delay-seconds"]);

  if (process.env.BRAINTRUST_API_KEY) {
    await validateBraintrustAccess({
      apiKey: process.env.BRAINTRUST_API_KEY,
      orgName: process.env.BRAINTRUST_ORG_NAME,
    });
    configureTracing({
      apiKey: process.env.BRAINTRUST_API_KEY,
      projectName: process.env.BRAINTRUST_PROJECT ?? DEFAULT_BRAINTRUST_PROJECT,
      projectId: process.env.BRAINTRUST_PROJECT_ID,
      asyncFlush: false,
    });
  } else if (values["require-braintrust"]) {
    throw new Error("BRAINTRUST_API_KEY is required for this run.");
  }

  if (values["quota-preflight"]) {
    const preflight = await quotaPreflightOk();
    if (!preflight.ok) {
      console.log("Hard quota appears exhausted; skipping this batch run.");
      console.log(preflight.reason);
      return;
    }
  }

  const questions = await generateQuestions(numQuestions, seed);

  console.log(`Generated ${questions.length} questions`);
  console.log(`Running with concurrency=${concurrency}`);
  console.log(`Model pool: ${MODEL_POOL.join(", ")}`);
  console.log("=".repeat(80));

  let successes = 0;
  let failures = 0;
  let hardQuotaStop = false;

  for (let index = 0; index < questions.length; index += concurrency) {
    if (hardQuotaStop) {
      break;
    }

    const batch = questions.slice(index, index + concurrency);
    const results = await Promise.all(
      batch.map((question) =>
        runQuestion({
          question,
          maxRetries,
          baseRetrySeconds,
        }),
      ),
    );

    for (const result of results) {
      if (result.ok) {
        successes += 1;
      } else {
        failures += 1;
      }
      if (result.hardStop) {
        hardQuotaStop = true;
      }
    }

    if (hardQuotaStop) {
      console.log("Hard quota exhausted; stopping remaining questions to avoid repeated 429s.");
      break;
    }

    if (interQuestionDelaySeconds > 0) {
      await new Promise((resolve) => setTimeout(resolve, interQuestionDelaySeconds * 1000));
    }

    console.log();
  }

  console.log("=".repeat(80));
  console.log(`Completed. successes=${successes} failures=${failures}`);
  console.log("=".repeat(80));

  await flushTracing();

  if (values["fail-on-error"] && failures > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
