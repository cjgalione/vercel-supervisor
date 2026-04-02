# Vercel AI SDK Supervisor

Multi-agent supervisor system built on Vercel AI SDK Core.

## What changed

- Runtime moved to TypeScript (`src-ts/`) with Vercel AI SDK + OpenAI provider.
- Braintrust tracing now uses `wrapAISDK` and explicit spans.
- Braintrust evals are now TypeScript (`evals/*.ts`) with Zod parameters.
- Daily query runner is now TypeScript (`scripts/run_queries.ts`).
- Repository is TypeScript-only for runtime, evals, and scripts.

## Setup

```bash
npm ci
cp .env.example .env
```

Required env vars:

- `OPENAI_API_KEY`
- `TAVILY_API_KEY`
- `BRAINTRUST_API_KEY` (for tracing/evals)
- Optional: `BRAINTRUST_PROJECT`, `BRAINTRUST_PROJECT_ID`, `TRACE_PROFILE=full|lean`

## Local run

```bash
npm run run:local
```

## Single query retest

```bash
npm run run:query -- --query "What is 12*9?"
```

## Daily query batch locally

```bash
npm run run:queries -- --num-questions 25 --concurrency 1
```

## Evals

```bash
npm run eval
```

Targeted:

```bash
bt eval evals/eval_supervisor.ts
bt eval evals/eval_math_agent.ts
bt eval evals/eval_research_agent.ts
```

## Modal remote eval

Deploy:

```bash
npm run eval:dev
```

This starts Braintrust eval dev mode directly from Node.
