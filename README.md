# Vercel AI SDK Supervisor

Multi-agent supervisor system ported from Google ADK to Vercel AI SDK Core.

## What changed

- Runtime moved to TypeScript (`src-ts/`) with Vercel AI SDK + Gemini provider.
- Braintrust tracing now uses `wrapAISDK` and explicit spans.
- Braintrust evals are now TypeScript (`evals/*.ts`) with Zod parameters.
- Daily query runner is now TypeScript (`scripts/run_queries.ts`).
- Modal remote eval keeps a thin Python wrapper that proxies to `braintrust eval evals --dev`.

Legacy Python files remain during dual-run/cutover for compatibility.

## Setup

```bash
npm ci
cp .env.example .env
```

Required env vars:

- `GOOGLE_API_KEY` (or `GOOGLE_GENERATIVE_AI_API_KEY`)
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
modal deploy src/eval_server.py
```

The Modal app launches `npm run eval:dev` in-container and proxies requests.
