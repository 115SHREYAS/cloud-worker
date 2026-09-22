import { z } from "zod";

export const GitHubAccountTypeSchema = z.enum(["User", "Organization"]);
export type GitHubAccountType = z.infer<typeof GitHubAccountTypeSchema>;

export const GitHubRepoSelectionSchema = z.enum(["all", "selected"]);
export type GitHubRepoSelection = z.infer<typeof GitHubRepoSelectionSchema>;

export const GitHubInstallationSchema = z.object({
  id: z.number().int().positive(),
  accountLogin: z.string().min(1),
  accountType: GitHubAccountTypeSchema,
  repositorySelection: GitHubRepoSelectionSchema,
  appSlug: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type GitHubInstallation = z.infer<typeof GitHubInstallationSchema>;

export const GitHubRepositorySchema = z.object({
  id: z.number().int().positive(),
  owner: z.string().min(1),
  name: z.string().min(1),
  fullName: z.string().min(1),
  private: z.boolean(),
  defaultBranch: z.string().default("main"),
  htmlUrl: z.string().url(),
  installationId: z.number().int().positive(),
});
export type GitHubRepository = z.infer<typeof GitHubRepositorySchema>;

export const CreatePullRequestInputSchema = z.object({
  installationId: z.number().int().positive().optional(),
  owner: z.string().min(1),
  repo: z.string().min(1),
  branch: z.string().min(1),
  baseBranch: z.string().min(1).default("main"),
  title: z.string().min(1),
  body: z.string(),
});
export type CreatePullRequestInput = z.infer<typeof CreatePullRequestInputSchema>;

export const PullRequestResultSchema = z.object({
  pullRequestNumber: z.number().int().positive(),
  pullRequestUrl: z.string().url(),
  state: z.string().default("open"),
});
export type PullRequestResult = z.infer<typeof PullRequestResultSchema>;
