import { loadConfig } from "../config.js";
import type { TaskProvider } from "./provider.js";
import { jiraProvider } from "./jira.js";
import { linearProvider } from "./linear.js";

export function getTaskProvider(): TaskProvider {
  const cfg = loadConfig();
  switch (cfg.TASK_PROVIDER) {
    case "jira":
      return jiraProvider;
    case "linear":
      return linearProvider;
  }
}

export type { TaskProvider } from "./provider.js";
