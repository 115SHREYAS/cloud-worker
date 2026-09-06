import { z } from "zod";

export const TaskStatusSchema = z.enum([
  "pending",
  "provisioning",
  "cloning",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const RepoRefSchema = z.object({
  owner: z.string().min(1, "Repository owner is required"),
  repo: z.string().min(1, "Repository name is required"),
  branch: z.string().min(1).default("main"),
  baseCommit: z.string().optional(),
  installationId: z.number().int().positive().optional(),
});

export type RepoRef = z.infer<typeof RepoRefSchema>;

export const CreateTaskInputSchema = z.object({
  repo: RepoRefSchema,
  prompt: z.string().min(5, "Prompt must be at least 5 characters long"),
  model: z.string().default("claude-3-7-sonnet-20250219"),
});

export type CreateTaskInput = z.infer<typeof CreateTaskInputSchema>;

export const TokenUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  estimatedCostUsd: z.number().nonnegative().optional(),
});

export type TokenUsage = z.infer<typeof TokenUsageSchema>;

export const TaskSchema = z.object({
  id: z.string(),
  status: TaskStatusSchema,
  repo: RepoRefSchema,
  prompt: z.string(),
  model: z.string(),
  workingBranch: z.string(),
  sandboxId: z.string().optional(),
  pullRequestUrl: z.string().url().optional(),
  tokenUsage: TokenUsageSchema.optional(),
  error: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
});

export type Task = z.infer<typeof TaskSchema>;

export const TaskSummarySchema = TaskSchema.pick({
  id: true,
  status: true,
  repo: true,
  prompt: true,
  createdAt: true,
  completedAt: true,
});

export type TaskSummary = z.infer<typeof TaskSummarySchema>;
