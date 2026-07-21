/**
 * Interfaz del gestor de tareas externo. Hoy: Jira Cloud. La interfaz existe
 * para poder cambiar a Linear/GitLab/Redmine sin tocar el agente.
 */

export type TaskSummary = {
  key: string;
  summary: string;
  status: string;
  priority: string | null;
  assignee: string | null;
  updatedAt: string | null;
  url: string;
};

export type TaskDetail = TaskSummary & {
  description: string;
  labels: string[];
  comments: { author: string; body: string; createdAt: string }[];
};

export type CreateTaskInput = {
  summary: string;
  description: string;
  priority?: string;
  assigneeAccountId?: string;
  labels?: string[];
};

export type UpdateTaskInput = {
  summary?: string;
  description?: string;
  priority?: string;
  assigneeAccountId?: string;
  labels?: string[];
};

export type AssignableUser = { accountId: string; displayName: string; email: string | null };

export interface TaskProvider {
  readonly name: string;
  /** Búsqueda por texto libre (y opcionalmente query nativa del proveedor). */
  searchTasks(text: string, opts?: { nativeQuery?: string; includeDone?: boolean }): Promise<TaskSummary[]>;
  getTask(key: string): Promise<TaskDetail>;
  createTask(input: CreateTaskInput): Promise<TaskSummary>;
  updateTask(key: string, patch: UpdateTaskInput): Promise<void>;
  addComment(key: string, body: string): Promise<void>;
  /** Mueve el ticket al estado indicado (nombre aproximado). Devuelve el estado aplicado. */
  transitionTask(key: string, targetStatus: string): Promise<string>;
  listAssignableUsers(query: string): Promise<AssignableUser[]>;
  /** Comprobación de conectividad/credenciales para /admin/overview. */
  healthcheck(): Promise<{ ok: boolean; detail: string }>;
}
