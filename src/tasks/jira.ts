import { loadConfig } from "../config.js";
import { logger } from "../log.js";
import type {
  AssignableUser,
  CreateTaskInput,
  TaskDetail,
  TaskProvider,
  TaskSummary,
  UpdateTaskInput,
} from "./provider.js";

const log = logger("jira");

/**
 * Jira Cloud REST v3. Autenticación básica email + API token. Descripciones y
 * comentarios van en ADF (Atlassian Document Format) — aquí solo texto plano
 * convertido a párrafos.
 */

type AdfDoc = { type: "doc"; version: 1; content: unknown[] };

function textToAdf(text: string): AdfDoc {
  const paragraphs = text.split(/\n+/).filter((p) => p.trim().length > 0);
  return {
    type: "doc",
    version: 1,
    content: paragraphs.length
      ? paragraphs.map((p) => ({ type: "paragraph", content: [{ type: "text", text: p }] }))
      : [{ type: "paragraph", content: [] }],
  };
}

function adfToText(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(adfToText).join("");
  if (typeof node === "object") {
    const n = node as { type?: string; text?: string; content?: unknown[] };
    if (n.type === "text") return n.text ?? "";
    const inner = (n.content ?? []).map(adfToText).join("");
    if (n.type === "paragraph" || n.type === "heading") return inner + "\n";
    return inner;
  }
  return "";
}

function authHeader(): string {
  const cfg = loadConfig();
  return "Basic " + Buffer.from(`${cfg.JIRA_EMAIL}:${cfg.JIRA_API_TOKEN}`).toString("base64");
}

async function jiraFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const cfg = loadConfig();
  const res = await fetch(`${cfg.JIRA_BASE_URL.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: {
      Authorization: authHeader(),
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Jira ${path} → HTTP ${res.status}: ${body.slice(0, 400)}`);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

type JiraIssueFields = {
  summary?: string;
  status?: { name?: string };
  priority?: { name?: string };
  assignee?: { displayName?: string };
  updated?: string;
  description?: unknown;
  labels?: string[];
  comment?: {
    comments?: { author?: { displayName?: string }; body?: unknown; created?: string }[];
  };
};

function issueUrl(key: string): string {
  return `${loadConfig().JIRA_BASE_URL.replace(/\/$/, "")}/browse/${key}`;
}

function toSummary(issue: { key: string; fields?: JiraIssueFields }): TaskSummary {
  const f = issue.fields ?? {};
  return {
    key: issue.key,
    summary: f.summary ?? "",
    status: f.status?.name ?? "",
    priority: f.priority?.name ?? null,
    assignee: f.assignee?.displayName ?? null,
    updatedAt: f.updated ?? null,
    url: issueUrl(issue.key),
  };
}

/** Escapa comillas para inyectar texto en JQL de forma segura. */
function jqlQuote(text: string): string {
  return `"${text.replace(/[\\"]/g, " ").trim()}"`;
}

export const jiraProvider: TaskProvider = {
  name: "jira",

  async searchTasks(text, opts) {
    const cfg = loadConfig();
    const project = `project = ${jqlQuote(cfg.JIRA_PROJECT_KEY)}`;
    let jql: string;
    if (opts?.nativeQuery) {
      // La query nativa SIEMPRE se acota al proyecto configurado.
      jql = `${project} AND (${opts.nativeQuery})`;
    } else {
      const doneFilter = opts?.includeDone ? "" : " AND statusCategory != Done";
      const term = text.trim();
      jql = term
        ? `${project}${doneFilter} AND (summary ~ ${jqlQuote(term)} OR text ~ ${jqlQuote(term)}) ORDER BY updated DESC`
        : `${project}${doneFilter} ORDER BY updated DESC`;
    }
    const data = await jiraFetch<{ issues?: { key: string; fields?: JiraIssueFields }[] }>(
      `/rest/api/3/search/jql`,
      {
        method: "POST",
        body: JSON.stringify({
          jql,
          maxResults: 20,
          fields: ["summary", "status", "priority", "assignee", "updated"],
        }),
      },
    );
    return (data.issues ?? []).map(toSummary);
  },

  async getTask(key) {
    const issue = await jiraFetch<{ key: string; fields?: JiraIssueFields }>(
      `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,status,priority,assignee,updated,description,labels,comment`,
    );
    const f = issue.fields ?? {};
    const comments = (f.comment?.comments ?? []).slice(-10).map((c) => ({
      author: c.author?.displayName ?? "",
      body: adfToText(c.body).trim(),
      createdAt: c.created ?? "",
    }));
    return {
      ...toSummary(issue),
      description: adfToText(f.description).trim(),
      labels: f.labels ?? [],
      comments,
    } satisfies TaskDetail;
  },

  async createTask(input) {
    const cfg = loadConfig();
    const fields: Record<string, unknown> = {
      project: { key: cfg.JIRA_PROJECT_KEY },
      issuetype: { name: cfg.JIRA_ISSUE_TYPE },
      summary: input.summary,
      description: textToAdf(input.description),
    };
    if (input.priority) fields.priority = { name: input.priority };
    if (input.assigneeAccountId) fields.assignee = { accountId: input.assigneeAccountId };
    if (input.labels?.length) fields.labels = input.labels;

    const created = await jiraFetch<{ key: string }>(`/rest/api/3/issue`, {
      method: "POST",
      body: JSON.stringify({ fields }),
    });
    log.info(`Ticket creado: ${created.key}`);
    return this.getTask(created.key);
  },

  async updateTask(key, patch: UpdateTaskInput) {
    const fields: Record<string, unknown> = {};
    if (patch.summary !== undefined) fields.summary = patch.summary;
    if (patch.description !== undefined) fields.description = textToAdf(patch.description);
    if (patch.priority !== undefined) fields.priority = { name: patch.priority };
    if (patch.assigneeAccountId !== undefined)
      fields.assignee = patch.assigneeAccountId ? { accountId: patch.assigneeAccountId } : null;
    if (patch.labels !== undefined) fields.labels = patch.labels;
    if (Object.keys(fields).length === 0) return;
    await jiraFetch(`/rest/api/3/issue/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: JSON.stringify({ fields }),
    });
  },

  async addComment(key, body) {
    await jiraFetch(`/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
      method: "POST",
      body: JSON.stringify({ body: textToAdf(body) }),
    });
  },

  async transitionTask(key, targetStatus) {
    const data = await jiraFetch<{
      transitions?: { id: string; name: string; to?: { name?: string } }[];
    }>(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`);
    const transitions = data.transitions ?? [];
    const want = targetStatus.trim().toLowerCase();
    const match =
      transitions.find((t) => (t.to?.name ?? "").toLowerCase() === want) ??
      transitions.find((t) => t.name.toLowerCase() === want) ??
      transitions.find(
        (t) => (t.to?.name ?? "").toLowerCase().includes(want) || t.name.toLowerCase().includes(want),
      );
    if (!match) {
      const available = transitions.map((t) => t.to?.name ?? t.name).join(", ");
      throw new Error(`Sin transición hacia "${targetStatus}". Disponibles: ${available || "ninguna"}`);
    }
    await jiraFetch(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
      method: "POST",
      body: JSON.stringify({ transition: { id: match.id } }),
    });
    return match.to?.name ?? match.name;
  },

  async listAssignableUsers(query) {
    const cfg = loadConfig();
    const data = await jiraFetch<
      { accountId: string; displayName: string; emailAddress?: string }[]
    >(
      `/rest/api/3/user/assignable/search?project=${encodeURIComponent(cfg.JIRA_PROJECT_KEY)}&query=${encodeURIComponent(query)}&maxResults=20`,
    );
    return (data ?? []).map(
      (u): AssignableUser => ({
        accountId: u.accountId,
        displayName: u.displayName,
        email: u.emailAddress ?? null,
      }),
    );
  },

  async healthcheck() {
    const cfg = loadConfig();
    try {
      await jiraFetch(`/rest/api/3/project/${encodeURIComponent(cfg.JIRA_PROJECT_KEY)}`);
      return { ok: true, detail: `Proyecto ${cfg.JIRA_PROJECT_KEY} accesible` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  },
};
