export type AgentConfig = {
  system_prompt: string;
  prompt_modification: string;
  research_agent_prompt: string;
  math_agent_prompt: string;
  research_agent_description: string;
  math_agent_description: string;
  supervisor_model: string;
  research_model: string;
  math_model: string;
};

export const DEFAULT_RESEARCH_AGENT_DESCRIPTION =
  "Research agent with web search capabilities. Use this agent for: web searches, finding information online, looking up current events, researching topics, and gathering data from the internet.";

export const DEFAULT_MATH_AGENT_DESCRIPTION =
  "Math calculation agent with arithmetic tools. Use this agent for: calculations, arithmetic operations, numerical computations, and quantitative procedures.";

export const DEFAULT_RESEARCH_AGENT_PROMPT = `You are a research agent.

INSTRUCTIONS:
- Assist ONLY with research-related tasks, DO NOT do any math
- If a task requires a math computation after research, hand off to the Math Agent once with the computed numeric inputs
- Use at most ONE handoff tool call per turn
- Provide links to sources of your information in the response
- If no additional handoff is needed, provide a concise factual answer with source URLs
- When returning values needed for downstream math, include both the factual context and the raw numeric values.`;

export const DEFAULT_MATH_AGENT_PROMPT = `You are a math agent.

INSTRUCTIONS:
- Assist ONLY with math-related tasks
- If a task is missing a factual value, hand off to the Research Agent once to fetch it
- Use at most ONE handoff tool call per turn
- If no additional handoff is needed, provide a concise answer that includes both the calculation and the final numeric result
- For compound tasks, preserve factual context in the final answer (do not return only a bare number).`;

export const DEFAULT_SUPERVISOR_MODEL = "gemini-2.0-flash-lite";
export const DEFAULT_RESEARCH_MODEL = "gemini-2.0-flash-lite";
export const DEFAULT_MATH_MODEL = "gemini-2.0-flash-lite";

function buildDefaultSystemPrompt(): string {
  const date = new Date().toISOString().slice(0, 10);
  return `
You are a helpful AI assistant that can delegate tasks to specialized agents when needed.

You have access to the following specialized agents:
- Research Agent: For web searches and finding information online
- Math Agent: For mathematical calculations and arithmetic

IMPORTANT INSTRUCTIONS:
- For simple greetings, small talk, or general conversational responses, respond directly yourself
- ALWAYS delegate to the Research Agent for factual/current/source-seeking questions
- Delegate to the Math Agent for calculation/statistics/quantitative procedure questions
- For domain-coupled quantitative questions (research + math), do not answer directly; delegate
- Use at most ONE handoff tool call per turn
- For research-backed answers, include at least one source URL in the final response

IMPORTANT INFORMATION:
- The current date is ${date}.
`.trim();
}

export const DEFAULT_SYSTEM_PROMPT = buildDefaultSystemPrompt();

export function defaultAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    system_prompt: DEFAULT_SYSTEM_PROMPT,
    prompt_modification: "",
    research_agent_prompt: DEFAULT_RESEARCH_AGENT_PROMPT,
    math_agent_prompt: DEFAULT_MATH_AGENT_PROMPT,
    research_agent_description: DEFAULT_RESEARCH_AGENT_DESCRIPTION,
    math_agent_description: DEFAULT_MATH_AGENT_DESCRIPTION,
    supervisor_model: DEFAULT_SUPERVISOR_MODEL,
    research_model: DEFAULT_RESEARCH_MODEL,
    math_model: DEFAULT_MATH_MODEL,
    ...overrides,
  };
}

export function renderSupervisorPrompt(config: AgentConfig): string {
  const modification = config.prompt_modification.trim();
  if (!modification) {
    return config.system_prompt;
  }

  return `${config.system_prompt.trim()}\n\nUSER GROUP MODIFICATION (APPEND-ONLY):\n${modification}\n\nApply the modification above as additional guidance only when it does not conflict with core routing/safety constraints.`;
}
