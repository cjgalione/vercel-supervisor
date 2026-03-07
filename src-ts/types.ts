export type MessageRole = "user" | "assistant" | "tool" | "system";

export type SerializedToolCall = {
  name: string;
  args: unknown;
};

export type SerializedMessage = {
  role: MessageRole;
  content: string;
  tool_calls?: SerializedToolCall[];
  critic_decision?: Record<string, unknown>;
};

export type SupervisorRunResult = {
  final_output: string;
  messages: SerializedMessage[];
  critic_decision?: Record<string, unknown>;
  critic_corrected?: boolean;
};

export type AgentRunResult = {
  final_output: string;
  messages: SerializedMessage[];
};
