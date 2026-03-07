import type { SerializedMessage } from "./types.js";

export function extractQueryFromInput(inputPayload: Record<string, unknown>): string {
  if (typeof inputPayload.query === "string" && inputPayload.query.trim()) {
    return inputPayload.query;
  }

  const newMessage = inputPayload.new_message;
  if (newMessage && typeof newMessage === "object") {
    const typed = newMessage as Record<string, unknown>;
    const parts = typed.parts;
    if (Array.isArray(parts)) {
      const texts = parts
        .filter((part): part is Record<string, unknown> => typeof part === "object" && part !== null)
        .map((part) => part.text)
        .filter((text): text is string => typeof text === "string" && text.trim().length > 0)
        .map((text) => text.trim());
      if (texts.length > 0) {
        return texts.join("\n");
      }
    }

    if (typeof typed.content === "string" && typed.content.trim()) {
      return typed.content;
    }
  }

  const messages = inputPayload.messages;
  if (Array.isArray(messages) && messages.length > 0) {
    const first = messages[0];
    if (first && typeof first === "object") {
      const content = (first as Record<string, unknown>).content;
      if (typeof content === "string") {
        return content;
      }
    }
  }

  throw new Error("Could not extract user query from input payload");
}

export function inferAgentsFromMessages(messages: SerializedMessage[]): string[] {
  const found = new Set<string>();

  for (const message of messages) {
    if (!Array.isArray(message.tool_calls)) {
      continue;
    }
    for (const toolCall of message.tool_calls) {
      const name = toolCall.name.toLowerCase();
      if (
        name.includes("research") ||
        name.includes("tavily") ||
        name.includes("delegate_to_research_agent")
      ) {
        found.add("ResearchAgent");
      }
      if (
        name.includes("math") ||
        name.includes("delegate_to_math_agent") ||
        ["add", "subtract", "multiply", "divide"].includes(name)
      ) {
        found.add("MathAgent");
      }
    }
  }

  return ["ResearchAgent", "MathAgent"].filter((name) => found.has(name));
}
