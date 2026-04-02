import { openaiModel } from "../model.js";
import { getAISDK } from "../tracing.js";
import type { SerializedMessage } from "../types.js";

export const DEFAULT_CRITIC_AGENT_PROMPT = `You are CriticAgent. Validate whether the candidate answer follows delegation policy.
Policy:
- Math-like queries MUST involve MathAgent handoff/tool usage evidence.
- Factual/latest/source-seeking queries MUST involve ResearchAgent handoff and web-search evidence.
- If policy-triggering query was answered directly without required delegation, reject.
Return JSON ONLY with schema:
{"compliant": true|false, "required_action": "accept"|"delegate_research"|"delegate_math"|"retry_with_instruction", "rationale": "short explanation"}
No markdown or extra keys.`;

export type CriticDecision = {
  compliant: boolean;
  required_action: "accept" | "delegate_research" | "delegate_math" | "retry_with_instruction";
  rationale: string;
};

export async function runCriticAgent(options: {
  query: string;
  candidateFinalOutput: string;
  messages: SerializedMessage[];
  model?: string;
  systemPrompt?: string;
}): Promise<Partial<CriticDecision>> {
  const aiSdk = getAISDK();
  const payload = {
    query: options.query,
    candidate_final_output: options.candidateFinalOutput,
    messages: options.messages,
  };

  const response = await aiSdk.generateText({
    model: openaiModel(options.model ?? "gpt-4.1-mini"),
    system: options.systemPrompt ?? DEFAULT_CRITIC_AGENT_PROMPT,
    prompt: `Evaluate this candidate against delegation policy and return JSON only.\n${JSON.stringify(payload)}`,
  });

  const rawText = (response.text ?? "").trim();
  try {
    return JSON.parse(rawText) as Partial<CriticDecision>;
  } catch {
    return {};
  }
}
