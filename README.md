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
- Optional Braintrust AI Gateway:
  - `BRAINTRUST_USE_GATEWAY=true`
  - `BRAINTRUST_GATEWAY_URL=https://gateway.braintrust.dev`
  - `BRAINTRUST_GATEWAY_API_KEY` (falls back to `BRAINTRUST_API_KEY`)

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

Push shared eval parameters first (creates a versioned Parameters object in Braintrust):

```bash
npm run eval:push-params
```

Then run evals:

```bash
npm run eval
```

Targeted:

```bash
bt eval evals/eval_supervisor.ts
bt eval evals/eval_math_agent.ts
bt eval evals/eval_research_agent.ts
```

Remote eval playground:

1. Add your dev server as a remote eval source.
2. The parameters from `supervisor-eval-parameters` appear as editable controls.
3. Use the playground parameter version selector to compare runs across saved versions.

## Braintrust AI Gateway

When `BRAINTRUST_USE_GATEWAY=true`, model calls are routed through the Braintrust gateway
using an OpenAI-compatible endpoint. Existing model values are supported:

- Unprefixed IDs like `gemini-2.0-flash-lite` are used directly.
- Explicit provider IDs like `google/gemini-2.0-flash-lite` or `openai/gpt-4o-mini` are accepted and normalized to endpoint-compatible model IDs.

Gateway mode applies to local runtime, eval tasks, and query scripts.

## Modal remote eval

Deploy:

```bash
modal deploy src/eval_server.py
```

The Modal app launches `npm run eval:dev` in-container and proxies requests.
