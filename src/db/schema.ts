import {
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

/* =============================================================================
   TDP Agente de tareas — Esquema PostgreSQL
   Chats de WhatsApp observados, mensajes normalizados (con transcripciones),
   personas (mapeo WhatsApp → gestor de tareas), tickets vinculados y auditoría
   completa de cada ejecución/acción del agente.
   ============================================================================= */

/** Chats conocidos (grupos y directos). Solo se procesan los `monitored`. */
export const chats = pgTable("chats", {
  id: serial("id").primaryKey(),
  /** JID de WhatsApp: 1203...@g.us (grupo) o 34600...@s.whatsapp.net (directo) */
  jid: varchar("jid", { length: 120 }).notNull().unique(),
  name: varchar("name", { length: 200 }).notNull().default(""),
  isGroup: boolean("is_group").notNull().default(false),
  /** El agente lee y actúa sobre este chat (se activa desde TDP Gestión). */
  monitored: boolean("monitored").notNull().default(false),
  /** Permitir al agente responder EN el chat (además del modo global). */
  allowReplies: boolean("allow_replies").notNull().default(false),
  /** Contexto extra para el agente: de qué va este grupo, reglas propias… */
  notes: text("notes"),
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Personas vistas en los chats. El mapeo a Jira se rellena desde TDP Gestión. */
export const people = pgTable("people", {
  id: serial("id").primaryKey(),
  /** JID del participante (34600...@s.whatsapp.net o ...@lid) */
  jid: varchar("jid", { length: 120 }).notNull().unique(),
  /** Nombre que muestra WhatsApp (pushName del último mensaje) */
  pushName: varchar("push_name", { length: 200 }).notNull().default(""),
  /** Nombre real asignado desde el panel (prima sobre pushName) */
  displayName: varchar("display_name", { length: 200 }),
  /** accountId de Jira para asignarle tareas (vacío = no asignable) */
  taskAccountId: varchar("task_account_id", { length: 128 }),
  /** Alias con los que se le menciona en los chats ("Rulo, el jefe") */
  aliases: text("aliases"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const mediaStatusEnum = pgEnum("media_status", ["none", "pending", "done", "error"]);

/**
 * Mensajes normalizados de los chats monitorizados. `text` es el cuerpo/caption
 * original; `transcript` es el texto derivado por IA (transcripción de audio,
 * descripción de imagen/vídeo). El agente trabaja siempre sobre texto.
 */
export const messages = pgTable(
  "messages",
  {
    id: serial("id").primaryKey(),
    chatId: integer("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    /** id del mensaje en WhatsApp (key.id) — para dedupe y descarga de media */
    waMessageId: varchar("wa_message_id", { length: 120 }).notNull(),
    /** JID del autor dentro del grupo (key.participant) o del chat directo */
    senderJid: varchar("sender_jid", { length: 120 }).notNull().default(""),
    pushName: varchar("push_name", { length: 200 }).notNull().default(""),
    fromMe: boolean("from_me").notNull().default(false),
    /** conversation | extendedTextMessage | audioMessage | imageMessage | videoMessage | documentMessage | … */
    type: varchar("type", { length: 60 }).notNull(),
    /** Cuerpo del mensaje o caption del media */
    text: text("text").notNull().default(""),
    /** Texto derivado por IA: transcripción de audio / descripción de imagen o vídeo */
    transcript: text("transcript"),
    mediaStatus: mediaStatusEnum("media_status").notNull().default("none"),
    /** Metadatos del media (mimetype, segundos, tamaño…) tal cual llegan */
    mediaMeta: jsonb("media_meta"),
    /** Texto del mensaje citado (contextInfo.quotedMessage), si lo hay */
    quotedText: text("quoted_text"),
    /** Momento del mensaje según WhatsApp */
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
    /** true cuando el agente ya lo incluyó en una ejecución */
    processed: boolean("processed").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("messages_chat_wa_id").on(t.chatId, t.waMessageId)],
);

/**
 * Tickets del gestor externo que el agente ha creado o tocado desde cada chat.
 * Es la memoria anti-duplicados: se inyecta en el contexto de cada ejecución.
 */
export const taskLinks = pgTable(
  "task_links",
  {
    id: serial("id").primaryKey(),
    chatId: integer("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    provider: varchar("provider", { length: 40 }).notNull().default("jira"),
    /** Clave del ticket (TDP-123) */
    taskKey: varchar("task_key", { length: 60 }).notNull(),
    summary: text("summary").notNull().default(""),
    status: varchar("status", { length: 80 }).notNull().default(""),
    priority: varchar("priority", { length: 40 }),
    assignee: varchar("assignee", { length: 200 }),
    /** Última acción del agente sobre el ticket (created/commented/updated/transitioned) */
    lastAction: varchar("last_action", { length: 40 }).notNull().default("created"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("task_links_chat_key").on(t.chatId, t.provider, t.taskKey)],
);

export const runStatusEnum = pgEnum("agent_run_status", ["queued", "running", "success", "error"]);

/** Una ejecución del agente = un lote de mensajes nuevos de un chat. */
export const agentRuns = pgTable("agent_runs", {
  id: serial("id").primaryKey(),
  chatId: integer("chat_id")
    .notNull()
    .references(() => chats.id, { onDelete: "cascade" }),
  status: runStatusEnum("status").notNull().default("queued"),
  /** shadow = el agente razona y registra, pero NO escribe en Jira/WhatsApp */
  shadow: boolean("shadow").notNull().default(true),
  messageCount: integer("message_count").notNull().default(0),
  /** Resumen final del agente: qué entendió y qué hizo */
  summary: text("summary"),
  error: text("error"),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Cada llamada a herramienta dentro de una ejecución (auditoría completa). */
export const agentActions = pgTable("agent_actions", {
  id: serial("id").primaryKey(),
  runId: integer("run_id")
    .notNull()
    .references(() => agentRuns.id, { onDelete: "cascade" }),
  chatId: integer("chat_id")
    .notNull()
    .references(() => chats.id, { onDelete: "cascade" }),
  tool: varchar("tool", { length: 60 }).notNull(),
  input: jsonb("input").notNull(),
  /** Resultado devuelto al agente (o simulado en modo shadow) */
  result: text("result").notNull().default(""),
  ok: boolean("ok").notNull().default(true),
  /** false = modo shadow o herramienta de solo lectura sin efecto externo */
  executed: boolean("executed").notNull().default(false),
  /** Ticket afectado, si aplica (para filtrar la auditoría por ticket) */
  taskKey: varchar("task_key", { length: 60 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Ajustes en caliente del agente, editables desde TDP Gestión. */
export const agentSettings = pgTable("agent_settings", {
  key: varchar("key", { length: 120 }).primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
