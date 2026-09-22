import { Octokit } from "@octokit/rest";
import type { PullRequestResult, CreatePullRequestInput } from "@cloud-worker/shared";
import type { GitHubTokenManager } from "./token-manager";

export interface CreatePullRequestOptions extends CreatePullRequestInput {
  tokenManager?: GitHubTokenManager;
  fallbackGithubToken?: string;
  mockInDev?: boolean;
}

export function formatPullRequestBody(options: {
  taskId: string;
  prompt: string;
  model: string;
  workingBranch: string;
  diffSummary?: string;
}): string {
  const lines = [
    "## Summary",
    "This pull request was generated automatically by the Cloud Worker autonomous agent.",
    "",
    "### Agent Prompt",
    `> ${options.prompt.split("\n").join("\n> ")}`,
    "",
    "### Task Metadata",
    `- **Task ID**: \`${options.taskId}\``,
    `- **Model**: \`${options.model}\``,
    `- **Working branch**: \`${options.workingBranch}\``,
  ];

  if (options.diffSummary && options.diffSummary.trim().length > 0) {
    lines.push("", "### Diff Overview", "```diff", options.diffSummary.slice(0, 4000), "```");
  }

  lines.push("", "---", "*Automated pull request opened by Cloud Worker.*");
  return lines.join("\n");
}

export async function createPullRequest(
  options: CreatePullRequestOptions,
): Promise<PullRequestResult> {
  const {
    owner,
    repo,
    branch,
    baseBranch = "main",
    title,
    body,
    installationId,
    tokenManager,
    fallbackGithubToken = process.env.GITHUB_TOKEN,
    mockInDev = false,
  } = options;

  let octokit: Octokit | null = null;

  if (tokenManager && tokenManager.isConfigured() && installationId) {
    try {
      octokit = await tokenManager.getInstallationOctokit(installationId);
    } catch (err) {
      console.warn(`[github-pr] Failed to get installation Octokit for ${installationId}:`, err);
    }
  }

  if (!octokit && fallbackGithubToken) {
    octokit = new Octokit({ auth: fallbackGithubToken });
  }

  if (!octokit) {
    if (mockInDev || process.env.NODE_ENV === "test") {
      const mockNumber = Math.floor(Math.random() * 900) + 100;
      console.log(`[github-pr] Mocking pull request for ${owner}/${repo} #${mockNumber}`);
      return {
        pullRequestNumber: mockNumber,
        pullRequestUrl: `https://github.com/${owner}/${repo}/pull/${mockNumber}`,
        state: "open",
      };
    }
    throw new Error("Cannot create pull request: no GitHub App credentials or GITHUB_TOKEN configured");
  }


  try {
    const res = await octokit.rest.pulls.create({
      owner,
      repo,
      title,
      head: branch,
      base: baseBranch,
      body,
    });

    return {
      pullRequestNumber: res.data.number,
      pullRequestUrl: res.data.html_url,
      state: res.data.state,
    };
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);

    // If PR already exists for this branch, query and return the existing PR
    if (errMsg.toLowerCase().includes("a pull request already exists")) {
      try {
        const existing = await octokit.rest.pulls.list({
          owner,
          repo,
          head: `${owner}:${branch}`,
          state: "open",
        });
        const first = existing.data[0];
        if (first) {
          return {
            pullRequestNumber: first.number,
            pullRequestUrl: first.html_url,
            state: first.state,
          };
        }
      } catch (listErr) {
        console.warn("[github-pr] Failed to lookup existing PR:", listErr);
      }
    }

    throw new Error(`Failed to create GitHub pull request: ${errMsg}`);
  }
}
