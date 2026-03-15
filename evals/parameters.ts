import type { Prompt } from "braintrust";
import { z } from "zod";

import {
  DEFAULT_MATH_AGENT_PROMPT,
  DEFAULT_MATH_MODEL,
  DEFAULT_RESEARCH_AGENT_PROMPT,
  DEFAULT_RESEARCH_MODEL,
  DEFAULT_SUPERVISOR_MODEL,
  DEFAULT_SYSTEM_PROMPT,
} from "../src-ts/config.js";

function promptParameter(defaultPrompt: string, model: string, description: string) {
  return {
    type: "prompt" as const,
    default: {
      prompt: defaultPrompt,
      model,
    },
    description,
  };
}

export const evalParameters = {
  system_prompt: promptParameter(
    DEFAULT_SYSTEM_PROMPT,
    DEFAULT_SUPERVISOR_MODEL,
    "Custom system prompt for supervisor.",
  ),
  research_agent_prompt: promptParameter(
    DEFAULT_RESEARCH_AGENT_PROMPT,
    DEFAULT_RESEARCH_MODEL,
    "Custom system prompt for research agent.",
  ),
  math_agent_prompt: promptParameter(
    DEFAULT_MATH_AGENT_PROMPT,
    DEFAULT_MATH_MODEL,
    "Custom system prompt for math agent.",
  ),
  prompt_modification: z
    .string()
    .default("")
    .describe("Optional append-only modification for the supervisor prompt."),
  supervisor_model: z
    .string()
    .default(DEFAULT_SUPERVISOR_MODEL)
    .describe("Model to use for supervisor agent."),
  research_model: z.string().default(DEFAULT_RESEARCH_MODEL).describe("Model to use for research agent."),
  math_model: z.string().default(DEFAULT_MATH_MODEL).describe("Model to use for math agent."),
};

export type EvalParameters = {
  [K in keyof typeof evalParameters]: (typeof evalParameters)[K] extends { type: "prompt" }
    ? Prompt
    : (typeof evalParameters)[K] extends z.ZodTypeAny
      ? z.infer<(typeof evalParameters)[K]>
      : never;
};

export const EVAL_PARAMETERS_PROJECT_NAME = "vercel-ai-sdk-supervisor";
export const EVAL_PARAMETERS_SLUG = "supervisor-eval-parameters-prompt-objects";
export const EVAL_PARAMETERS_NAME = "Supervisor Eval Parameters";

export function resolvePromptText(prompt: string | Prompt): string {
  if (typeof prompt === "string") {
    return prompt;
  }

  const promptBlock = prompt.prompt;
  if (promptBlock.type === "completion") {
    return promptBlock.content;
  }

  return promptBlock.messages
    .flatMap((message) => {
      if (typeof message.content === "string") {
        return [message.content];
      }
      return message.content.flatMap((part) => ("text" in part ? [part.text] : []));
    })
    .join("\n\n");
}
