CREATE TABLE "auth_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text DEFAULT 'default' NOT NULL,
	"provider" text NOT NULL,
	"auth_json" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"repo_owner" text NOT NULL,
	"repo_name" text NOT NULL,
	"repo_branch" text DEFAULT 'main' NOT NULL,
	"repo_base_commit" text,
	"repo_installation_id" integer,
	"prompt" text NOT NULL,
	"model" text DEFAULT 'claude-3-7-sonnet-20250219' NOT NULL,
	"working_branch" text NOT NULL,
	"sandbox_id" text,
	"pull_request_url" text,
	"error" text,
	"diff" text,
	"token_input_tokens" integer,
	"token_output_tokens" integer,
	"token_total_tokens" integer,
	"token_estimated_cost_usd" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "task_logs" ADD CONSTRAINT "task_logs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;