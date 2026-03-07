#!/usr/bin/env node
import "dotenv/config";

import { parseArgs } from "node:util";

import { defaultAgentConfig, type AgentConfig } from "../src-ts/config.js";
import { stableJson } from "../src-ts/serializer.js";
import { configureTracing, flushTracing } from "../src-ts/tracing.js";
import { getSupervisor, runSupervisorWithCritic } from "../src-ts/supervisor.js";

const DEFAULT_PROJECT = "vercel-ai-sdk-supervisor";
const DEFAULT_SUPERVISOR_MODEL = "gemini-2.0-flash-lite";

function parseMetadata(raw: string[] | undefined): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  for (const item of raw ?? []) {
    const idx = item.indexOf("=");
    if (idx <= 0) {
      throw new Error(`Invalid --trace-metadata entry: ${item}`);
    }
    const key = item.slice(0, idx).trim();
    const value = item.slice(idx + 1).trim();
    if (!key) {
      throw new Error(`Invalid --trace-metadata entry: ${item}`);
    }

    try {
      metadata[key] = JSON.parse(value);
    } catch {
      metadata[key] = value;
    }
  }
  return metadata;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      query: { type: "string" },
      project: { type: "string", default: process.env.BRAINTRUST_PROJECT ?? DEFAULT_PROJECT },
      "supervisor-model": { type: "string" },
      "research-model": { type: "string" },
      "math-model": { type: "string" },
      "workflow-name": { type: "string", default: "vercel-ai-sdk-supervisor-retest" },
      "trace-metadata": { type: "string", multiple: true },
      "trace-metadata-json": { type: "string" },
      "no-braintrust": { type: "boolean", default: false },
    },
  });

  const query = values.query;
  if (!query) {
    throw new Error("--query is required");
  }

  const supervisorModel = values["supervisor-model"] ?? DEFAULT_SUPERVISOR_MODEL;
  const researchModel = values["research-model"] ?? supervisorModel;
  const mathModel = values["math-model"] ?? supervisorModel;

  const metadata = parseMetadata(values["trace-metadata"]);
  if (values["trace-metadata-json"]) {
    const parsed = JSON.parse(values["trace-metadata-json"]);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("--trace-metadata-json must be a JSON object");
    }
    Object.assign(metadata, parsed);
  }
  metadata.selected_model = supervisorModel;

  if (!values["no-braintrust"]) {
    if (!process.env.BRAINTRUST_API_KEY) {
      throw new Error("BRAINTRUST_API_KEY is missing. Set it or pass --no-braintrust.");
    }
    configureTracing({
      apiKey: process.env.BRAINTRUST_API_KEY,
      projectName: values.project,
      projectId: process.env.BRAINTRUST_PROJECT_ID,
      asyncFlush: false,
    });
  }

  const config: Partial<AgentConfig> = {
    supervisor_model: supervisorModel,
    research_model: researchModel,
    math_model: mathModel,
  };

  const supervisor = getSupervisor({ config: defaultAgentConfig(config), forceRebuild: true });
  const result = await runSupervisorWithCritic({
    supervisor,
    query,
    appName: values["workflow-name"] ?? "vercel-ai-sdk-supervisor-retest",
  });

  console.log(`FINAL: ${result.final_output}`);
  console.log("MESSAGES:");
  console.log(stableJson(result.messages));

  if (Object.keys(metadata).length > 0) {
    console.log("TRACE METADATA:");
    console.log(stableJson(metadata));
  }

  await flushTracing();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
