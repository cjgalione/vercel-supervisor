import "dotenv/config";

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { configureTracing, flushTracing } from "../tracing.js";
import { getSupervisor, runSupervisorWithCritic } from "../supervisor.js";

const DEFAULT_BRAINTRUST_PROJECT = "vercel-ai-sdk-supervisor";

async function main(): Promise<void> {
  if (process.env.BRAINTRUST_API_KEY) {
    configureTracing({
      apiKey: process.env.BRAINTRUST_API_KEY,
      projectName: process.env.BRAINTRUST_PROJECT ?? DEFAULT_BRAINTRUST_PROJECT,
      projectId: process.env.BRAINTRUST_PROJECT_ID,
    });
  }

  const rl = createInterface({ input, output });
  const supervisor = getSupervisor();

  output.write("Vercel AI SDK Supervisor Chat (OpenAI)\nType 'quit' or 'q' to exit.\n\n");

  try {
    while (true) {
      const userInput = (await rl.question("You: ")).trim();
      if (!userInput) {
        continue;
      }

      if (["q", "quit", "exit"].includes(userInput.toLowerCase())) {
        break;
      }

      const result = await runSupervisorWithCritic({
        supervisor,
        query: userInput,
        appName: "vercel-ai-sdk-supervisor-local",
      });

      output.write(`Assistant: ${result.final_output || "(No response generated)"}\n\n`);
    }
  } finally {
    rl.close();
    await flushTracing();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
