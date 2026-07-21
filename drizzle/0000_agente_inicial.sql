CREATE TYPE "public"."media_status" AS ENUM('none', 'pending', 'done', 'error');--> statement-breakpoint
CREATE TYPE "public"."agent_run_status" AS ENUM('queued', 'running', 'success', 'error');--> statement-breakpoint
CREATE TABLE "agent_actions" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"chat_id" integer NOT NULL,
	"tool" varchar(60) NOT NULL,
	"input" jsonb NOT NULL,
	"result" text DEFAULT '' NOT NULL,
	"ok" boolean DEFAULT true NOT NULL,
	"executed" boolean DEFAULT false NOT NULL,
	"task_key" varchar(60),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"chat_id" integer NOT NULL,
	"status" "agent_run_status" DEFAULT 'queued' NOT NULL,
	"shadow" boolean DEFAULT true NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"summary" text,
	"error" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_settings" (
	"key" varchar(120) PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chats" (
	"id" serial PRIMARY KEY NOT NULL,
	"jid" varchar(120) NOT NULL,
	"name" varchar(200) DEFAULT '' NOT NULL,
	"is_group" boolean DEFAULT false NOT NULL,
	"monitored" boolean DEFAULT false NOT NULL,
	"allow_replies" boolean DEFAULT false NOT NULL,
	"notes" text,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chats_jid_unique" UNIQUE("jid")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"chat_id" integer NOT NULL,
	"wa_message_id" varchar(120) NOT NULL,
	"sender_jid" varchar(120) DEFAULT '' NOT NULL,
	"push_name" varchar(200) DEFAULT '' NOT NULL,
	"from_me" boolean DEFAULT false NOT NULL,
	"type" varchar(60) NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"transcript" text,
	"media_status" "media_status" DEFAULT 'none' NOT NULL,
	"media_meta" jsonb,
	"quoted_text" text,
	"sent_at" timestamp with time zone NOT NULL,
	"processed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "people" (
	"id" serial PRIMARY KEY NOT NULL,
	"jid" varchar(120) NOT NULL,
	"push_name" varchar(200) DEFAULT '' NOT NULL,
	"display_name" varchar(200),
	"task_account_id" varchar(128),
	"aliases" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "people_jid_unique" UNIQUE("jid")
);
--> statement-breakpoint
CREATE TABLE "task_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"chat_id" integer NOT NULL,
	"provider" varchar(40) DEFAULT 'jira' NOT NULL,
	"task_key" varchar(60) NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"status" varchar(80) DEFAULT '' NOT NULL,
	"priority" varchar(40),
	"assignee" varchar(200),
	"last_action" varchar(40) DEFAULT 'created' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_actions" ADD CONSTRAINT "agent_actions_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_actions" ADD CONSTRAINT "agent_actions_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_links" ADD CONSTRAINT "task_links_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_chat_wa_id" ON "messages" USING btree ("chat_id","wa_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_links_chat_key" ON "task_links" USING btree ("chat_id","provider","task_key");