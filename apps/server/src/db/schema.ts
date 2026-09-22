import { pgTable, text, integer, real, timestamp, jsonb } from "drizzle-orm/pg-core";

export const tasks = pgTable("tasks", {
  id: text("id").primaryKey(),
  status: text("status").notNull().default("pending"),
  repoOwner: text("repo_owner").notNull(),
  repoName: text("repo_name").notNull(),
  repoBranch: text("repo_branch").notNull().default("main"),
  repoBaseCommit: text("repo_base_commit"),
  repoInstallationId: integer("repo_installation_id"),
  prompt: text("prompt").notNull(),
  model: text("model").notNull().default("claude-3-7-sonnet-20250219"),
  workingBranch: text("working_branch").notNull(),
  sandboxId: text("sandbox_id"),
  pullRequestUrl: text("pull_request_url"),
  error: text("error"),
  diff: text("diff"),
  tokenInputTokens: integer("token_input_tokens"),
  tokenOutputTokens: integer("token_output_tokens"),
  tokenTotalTokens: integer("token_total_tokens"),
  tokenEstimatedCostUsd: real("token_estimated_cost_usd"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const taskLogs = pgTable("task_logs", {
  id: text("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const authSessions = pgTable("auth_sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().default("default"),
  provider: text("provider").notNull(),
  authJson: text("auth_json").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const githubInstallations = pgTable("github_installations", {
  id: text("id").primaryKey(),
  installationId: integer("installation_id").notNull().unique(),
  accountLogin: text("account_login").notNull(),
  accountType: text("account_type").notNull(),
  repositorySelection: text("repository_selection").notNull(),
  appSlug: text("app_slug"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type TaskRow = typeof tasks.$inferSelect;
export type InsertTaskRow = typeof tasks.$inferInsert;
export type TaskLogRow = typeof taskLogs.$inferSelect;
export type InsertTaskLogRow = typeof taskLogs.$inferInsert;
export type AuthSessionRow = typeof authSessions.$inferSelect;
export type InsertAuthSessionRow = typeof authSessions.$inferInsert;
export type GitHubInstallationRow = typeof githubInstallations.$inferSelect;
export type InsertGitHubInstallationRow = typeof githubInstallations.$inferInsert;

