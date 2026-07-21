import { loadConfig } from "../config.js";
import type { TaskProvider } from "./provider.js";
import { jiraProvider } from "./jira.js";

export function getTaskProvider(): TaskProvider {
  const cfg = loadConfig();
  switch (cfg.TASK_PROVIDER) {
    case "jira":
      return jiraProvider;
  }
}

export type { TaskProvider } from "./provider.js";
