import "dotenv/config";

import * as braintrust from "braintrust";

import {
  EVAL_PARAMETERS_NAME,
  EVAL_PARAMETERS_PROJECT_NAME,
  EVAL_PARAMETERS_SLUG,
  evalParameters,
} from "./parameters.js";

const project = braintrust.projects.create({
  name: process.env.BRAINTRUST_PROJECT ?? EVAL_PARAMETERS_PROJECT_NAME,
});

export const supervisorEvalParameters = project.parameters.create({
  name: EVAL_PARAMETERS_NAME,
  slug: EVAL_PARAMETERS_SLUG,
  description: "Configurable parameters for supervisor, research, and math eval tasks.",
  schema: evalParameters,
  metadata: {
    source: "vercel-supervisor",
  },
});
