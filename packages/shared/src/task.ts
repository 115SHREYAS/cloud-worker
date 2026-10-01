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

export const ReasoningEffortSchema = z.enum(["none", "low", "medium", "high"]);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

export interface ModelOption {
  id: string;
  name: string;
  provider: "codex" | "claude";
  description: string;
  supportsReasoning: boolean;
  defaultEffort?: ReasoningEffort;
  badge?: string;
  requiresApiKey?: boolean;
}

export const AVAILABLE_MODELS: ModelOption[] = [
  // OpenAI Codex models
  {
    id: "gpt-6-luna",
    name: "GPT-6-Luna",
    provider: "codex",
    description: "Frontier model for code and deep thought (ChatGPT Subscription)",
    supportsReasoning: true,
    defaultEffort: "medium",
    requiresApiKey: false,
  },
  {
    id: "gpt-5.6-luna",
    name: "GPT-5.6-Luna",
    provider: "codex",
    description: "Smart, efficient, and versatile frontier model for code and deep thought (ChatGPT Subscription)",
    supportsReasoning: true,
    defaultEffort: "medium",
    requiresApiKey: false,
  },
  {
    id: "gpt-5.6-terra",
    name: "GPT-5.6-Terra",
    provider: "codex",
    description: "Balanced model for straightforward programming work (ChatGPT Subscription)",
    supportsReasoning: true,
    defaultEffort: "medium",
    requiresApiKey: false,
  },
  {
    id: "gpt-5.5",
    name: "GPT-5.5",
    provider: "codex",
    description: "Fast coding model for iterations and bugfixes (ChatGPT Subscription)",
    supportsReasoning: true,
    defaultEffort: "medium",
    requiresApiKey: false,
  },
  {
    id: "codex",
    name: "OpenAI Codex Default",
    provider: "codex",
    description: "Standard autonomous harness using your ChatGPT Plus/Pro subscription or default CLI model",
    supportsReasoning: false,
    requiresApiKey: false,
  },
  {
    id: "gpt-4o",
    name: "GPT-4o",
    provider: "codex",
    description: "Versatile foundation model for vision and code (Requires OpenAI API Key)",
    supportsReasoning: false,
    badge: "API Key",
    requiresApiKey: true,
  },
  {
    id: "o3-mini",
    name: "OpenAI o3-mini",
    provider: "codex",
    description: "High-speed reasoning model tailored for math and coding benchmarks (Requires OpenAI API Key)",
    supportsReasoning: true,
    defaultEffort: "medium",
    badge: "API Key",
    requiresApiKey: true,
  },
  {
    id: "o3",
    name: "OpenAI o3",
    provider: "codex",
    description: "Frontier deep reasoning model for intricate architectural engineering (Requires OpenAI API Key)",
    supportsReasoning: true,
    defaultEffort: "high",
    badge: "API Key",
    requiresApiKey: true,
  },
  {
    id: "o1",
    name: "OpenAI o1",
    provider: "codex",
    description: "Multi-step reasoning and algorithmic problem solver (Requires OpenAI API Key)",
    supportsReasoning: true,
    defaultEffort: "medium",
    badge: "API Key",
    requiresApiKey: true,
  },
  {
    id: "gpt-4.5-preview",
    name: "GPT-4.5 Preview",
    provider: "codex",
    description: "Massive world knowledge and precision instruction following (Requires OpenAI API Key)",
    supportsReasoning: false,
    badge: "API Key",
    requiresApiKey: true,
  },
  {
    id: "gpt-4o-mini",
    name: "GPT-4o mini",
    provider: "codex",
    description: "Lightweight, ultra-fast model for small script changes (Requires OpenAI API Key)",
    supportsReasoning: false,
    badge: "API Key",
    requiresApiKey: true,
  },
  // Claude Code models
  {
    id: "claude-3-7-sonnet-20250219",
    name: "Claude 3.7 Sonnet",
    provider: "claude",
    description: "Hybrid reasoning model with extended thinking budget (Claude Pro/Team & API)",
    supportsReasoning: true,
    defaultEffort: "medium",
    requiresApiKey: false,
  },
  {
    id: "claude-3-5-sonnet-20241022",
    name: "Claude 3.5 Sonnet",
    provider: "claude",
    description: "Industry standard for full-stack codebase engineering (Claude Pro/Team & API)",
    supportsReasoning: false,
    requiresApiKey: false,
  },
  {
    id: "claude-3-5-haiku-20241022",
    name: "Claude 3.5 Haiku",
    provider: "claude",
    description: "Ultra-fast code iteration and concise refactors (Claude Pro/Team & API)",
    supportsReasoning: false,
    requiresApiKey: false,
  },
  {
    id: "claude-3-opus-20240229",
    name: "Claude 3 Opus",
    provider: "claude",
    description: "Deep analytical reasoning across large workspaces (Requires Anthropic API Key)",
    supportsReasoning: false,
    badge: "API Key",
    requiresApiKey: true,
  },
];

export function getSubscriptionModels(provider?: "codex" | "claude"): ModelOption[] {
  return AVAILABLE_MODELS.filter((m) => {
    if (provider && m.provider !== provider) return false;
    return !m.requiresApiKey;
  });
}

export function getAvailableModels(
  provider?: "codex" | "claude",
  hasApiKey = false,
): ModelOption[] {
  return AVAILABLE_MODELS.filter((m) => {
    if (provider && m.provider !== provider) return false;
    if (!hasApiKey && m.requiresApiKey) return false;
    return true;
  });
}

export const CreateTaskInputSchema = z.object({
  repo: RepoRefSchema,
  prompt: z.string().min(5, "Prompt must be at least 5 characters long"),
  model: z.string().default("codex"),
  reasoningEffort: ReasoningEffortSchema.optional(),
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
  reasoningEffort: ReasoningEffortSchema.optional(),
  workingBranch: z.string(),
  sandboxId: z.string().optional(),
  pullRequestUrl: z.string().url().optional(),
  diff: z.string().optional(),
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
