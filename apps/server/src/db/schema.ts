import { pgTable, text, integer, real, timestamp, jsonb, boolean } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  githubId: integer("github_id").notNull().unique(),
  username: text("username").notNull(),
  email: text("email").notNull(),
  avatarUrl: text("avatar_url").notNull(),
  defaultModel: text("default_model").notNull().default("codex"),
  defaultAuthMode: text("default_auth_mode").notNull().default("subscription"),
  onboardingCompleted: boolean("onboarding_completed").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const tasks = pgTable("tasks", {
  id: text("id").primaryKey(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("pending"),
  repoOwner: text("repo_owner").notNull(),
  repoName: text("repo_name").notNull(),
  repoBranch: text("repo_branch").notNull().default("main"),
  repoBaseCommit: text("repo_base_commit"),
  repoInstallationId: integer("repo_installation_id"),
  prompt: text("prompt").notNull(),
  model: text("model").notNull().default("codex"),
  reasoningEffort: text("reasoning_effort"),
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
  authMode: text("auth_mode").notNull().default("subscription"),
  authJson: text("auth_json").notNull(),
  iv: text("iv"),
  tag: text("tag"),
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

export const userGithubInstallations = pgTable("user_github_installations", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  installationId: integer("installation_id")
    .notNull()
    .references(() => githubInstallations.installationId, { onDelete: "cascade" }),
  linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
});

export type UserRow = typeof users.$inferSelect;
export type InsertUserRow = typeof users.$inferInsert;
export type TaskRow = typeof tasks.$inferSelect;
export type InsertTaskRow = typeof tasks.$inferInsert;
export type TaskLogRow = typeof taskLogs.$inferSelect;
export type InsertTaskLogRow = typeof taskLogs.$inferInsert;
export type AuthSessionRow = typeof authSessions.$inferSelect;
export type InsertAuthSessionRow = typeof authSessions.$inferInsert;
export type GitHubInstallationRow = typeof githubInstallations.$inferSelect;
export type InsertGitHubInstallationRow = typeof githubInstallations.$inferInsert;
export type UserGitHubInstallationRow = typeof userGithubInstallations.$inferSelect;
export type InsertUserGitHubInstallationRow = typeof userGithubInstallations.$inferInsert;
