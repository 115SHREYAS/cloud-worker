CREATE TABLE "github_installations" (
	"id" text PRIMARY KEY NOT NULL,
	"installation_id" integer NOT NULL,
	"account_login" text NOT NULL,
	"account_type" text NOT NULL,
	"repository_selection" text NOT NULL,
	"app_slug" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_installations_installation_id_unique" UNIQUE("installation_id")
);
--> statement-breakpoint
CREATE TABLE "user_github_installations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"installation_id" integer NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"github_id" integer NOT NULL,
	"username" text NOT NULL,
	"email" text NOT NULL,
	"avatar_url" text NOT NULL,
	"default_model" text DEFAULT 'codex' NOT NULL,
	"default_auth_mode" text DEFAULT 'subscription' NOT NULL,
	"onboarding_completed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_github_id_unique" UNIQUE("github_id")
);
--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "model" SET DEFAULT 'codex';--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD COLUMN "auth_mode" text DEFAULT 'subscription' NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD COLUMN "iv" text;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD COLUMN "tag" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "reasoning_effort" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "current_turn" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "queued_prompt" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "warm_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_github_installations" ADD CONSTRAINT "user_github_installations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_github_installations" ADD CONSTRAINT "user_github_installations_installation_id_github_installations_installation_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."github_installations"("installation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;