import * as ai from "ai";
import {
  flush,
  initLogger,
  startSpan,
  traced,
  wrapAISDK,
  type Span,
} from "braintrust";

let loggerInitialized = false;
let wrappedAI: typeof ai | null = null;

export type TraceProfile = "full" | "lean";

export function getTraceProfile(): TraceProfile {
  const profile = (process.env.TRACE_PROFILE ?? "full").trim().toLowerCase();
  return profile === "lean" ? "lean" : "full";
}

export function resolveOpenAIApiKey(): string | undefined {
  return process.env.OPENAI_API_KEY;
}

export function configureTracing(options?: {
  apiKey?: string;
  projectName?: string;
  projectId?: string;
  asyncFlush?: boolean;
}): void {
  const apiKey = options?.apiKey ?? process.env.BRAINTRUST_API_KEY;
  if (!apiKey || loggerInitialized) {
    return;
  }

  initLogger({
    apiKey,
    projectName: options?.projectName ?? process.env.BRAINTRUST_PROJECT,
    projectId: options?.projectId ?? process.env.BRAINTRUST_PROJECT_ID,
    asyncFlush: options?.asyncFlush ?? true,
  });

  loggerInitialized = true;
}

export function getAISDK(): typeof ai {
  if (!wrappedAI) {
    wrappedAI = wrapAISDK(ai);
  }
  return wrappedAI;
}

export async function withSpan<T>(
  args: Record<string, unknown>,
  callback: (span: Span) => Promise<T>,
): Promise<T> {
  return traced(callback, args as never);
}

export async function withChildSpan<T>(
  args: Record<string, unknown>,
  callback: (span: Span) => Promise<T>,
): Promise<T> {
  const span = startSpan(args as never);
  try {
    const result = await callback(span);
    span.log({ output: result as unknown });
    return result;
  } catch (error) {
    span.log({ error: String(error) });
    throw error;
  } finally {
    span.end();
  }
}

export async function flushTracing(): Promise<void> {
  await flush();
}
