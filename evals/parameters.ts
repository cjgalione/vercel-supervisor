import { z } from "zod";

import {
  DEFAULT_MATH_AGENT_PROMPT,
  DEFAULT_MATH_MODEL,
  DEFAULT_RESEARCH_AGENT_PROMPT,
  DEFAULT_RESEARCH_MODEL,
  DEFAULT_SUPERVISOR_MODEL,
  DEFAULT_SYSTEM_PROMPT,
} from "../src-ts/config.js";

export const evalParameters = {
  system_prompt: z.string().default(DEFAULT_SYSTEM_PROMPT).describe("Custom system prompt for supervisor."),
  prompt_modification: z
    .string()
    .default("")
    .describe("Optional append-only modification for the supervisor prompt."),
  research_agent_prompt: z
    .string()
    .default(DEFAULT_RESEARCH_AGENT_PROMPT)
    .describe("Custom system prompt for research agent."),
  math_agent_prompt: z
    .string()
    .default(DEFAULT_MATH_AGENT_PROMPT)
    .describe("Custom system prompt for math agent."),
  supervisor_model: z
    .string()
    .default(DEFAULT_SUPERVISOR_MODEL)
    .describe("Model to use for supervisor agent."),
  research_model: z.string().default(DEFAULT_RESEARCH_MODEL).describe("Model to use for research agent."),
  math_model: z.string().default(DEFAULT_MATH_MODEL).describe("Model to use for math agent."),
};

export type EvalParameters = {
  [K in keyof typeof evalParameters]: z.infer<(typeof evalParameters)[K]>;
};

export const EVAL_PARAMETERS_PROJECT_NAME = "vercel-ai-sdk-supervisor";
export const EVAL_PARAMETERS_SLUG = "supervisor-eval-parameters";
export const EVAL_PARAMETERS_NAME = "Supervisor Eval Parameters";
