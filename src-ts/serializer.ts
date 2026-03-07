import type { SerializedMessage } from "./types.js";

export class MessageRecorder {
  private readonly messages: SerializedMessage[];

  constructor(query: string) {
    this.messages = [{ role: "user", content: query }];
  }

  addAssistantText(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    this.messages.push({ role: "assistant", content: trimmed });
  }

  addToolCall(name: string, args: unknown): void {
    this.messages.push({
      role: "assistant",
      content: "",
      tool_calls: [{ name, args }],
    });
  }

  addToolResult(result: unknown): void {
    const content = typeof result === "string" ? result : JSON.stringify(result);
    this.messages.push({ role: "tool", content });
  }

  addSystem(content: string, criticDecision?: Record<string, unknown>): void {
    this.messages.push({
      role: "system",
      content,
      ...(criticDecision ? { critic_decision: criticDecision } : {}),
    });
  }

  addMessages(messages: SerializedMessage[]): void {
    this.messages.push(...messages);
  }

  hasMessageContent(content: string): boolean {
    return this.messages.some(
      (message) => message.role === "assistant" && message.content.trim() === content.trim(),
    );
  }

  toArray(): SerializedMessage[] {
    return [...this.messages];
  }
}

export function hasMarker(messages: SerializedMessage[], markers: string[]): boolean {
  const lowered = markers.map((marker) => marker.toLowerCase());
  return messages.some((message) => {
    const content = message.content.toLowerCase();
    if (lowered.some((marker) => content.includes(marker))) {
      return true;
    }

    if (!Array.isArray(message.tool_calls)) {
      return false;
    }

    return message.tool_calls.some((call) => {
      const name = call.name.toLowerCase();
      return lowered.some((marker) => name.includes(marker));
    });
  });
}

export function extractFloatFromText(text: string): number | null {
  const scientificCaretMatches = [...text.matchAll(/(-?\d+(?:\.\d+)?)\s*[x×]\s*10\^(-?\d+)/gi)];
  if (scientificCaretMatches.length > 0) {
    const [, base, exp] = scientificCaretMatches[scientificCaretMatches.length - 1];
    const parsedBase = Number(base);
    const parsedExp = Number(exp);
    if (!Number.isNaN(parsedBase) && !Number.isNaN(parsedExp)) {
      return parsedBase * 10 ** parsedExp;
    }
  }

  const matches = text.match(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g);
  if (!matches || matches.length === 0) {
    return null;
  }

  const value = Number(matches[matches.length - 1]);
  return Number.isNaN(value) ? null : value;
}

export function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
