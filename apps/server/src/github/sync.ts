import type { TaskRepository } from "../db/repository.ts";
import type { GitHubTokenManager } from "./token-manager.ts";
import type { GitHubInstallation } from "@cloud-worker/shared";

/**
 * Safely extracts the login identifier and account type from an Octokit account object,
 * handling User, Organization, and Enterprise unions safely.
 */
export function extractAccountInfo(account?: unknown): {
  login: string;
  type: "User" | "Organization";
} {
  if (!account || typeof account !== "object") {
    return { login: "unknown", type: "User" };
  }
  const acc = account as Record<string, unknown>;
  const login =
    typeof acc.login === "string"
      ? acc.login
      : typeof acc.slug === "string"
        ? acc.slug
        : typeof acc.name === "string"
          ? acc.name
          : "unknown";
  const type = acc.type === "Organization" ? "Organization" : "User";
  return { login, type };
}

/**
 * Synchronizes GitHub App installations directly from the GitHub API using the App Private Key.
 * This guarantees that even in local development or before webhooks arrive, installations and
 * repositories are always discovered and associated with the current user or database.
 */
export async function syncGitHubInstallations(
  repo: TaskRepository,
  tokenManager?: GitHubTokenManager,
  userId?: string,
): Promise<GitHubInstallation[]> {
  if (!tokenManager || !tokenManager.isConfigured()) {
    return repo.listInstallations();
  }

  try {
    const octokit = tokenManager.getAppOctokit();
    const { data: installations } = await octokit.rest.apps.listInstallations();

    const appSlug = process.env.GITHUB_APP_SLUG || "cloud-worker-app";
    const synced: GitHubInstallation[] = [];

    let targetUser = userId ? await repo.getUser(userId) : null;

    for (const inst of installations) {
      const accountInfo = extractAccountInfo(inst.account);
      const record: GitHubInstallation = {
        id: inst.id,
        accountLogin: accountInfo.login,
        accountType: accountInfo.type,
        repositorySelection: (inst.repository_selection as "all" | "selected") || "all",
        appSlug,
        createdAt: inst.created_at,
        updatedAt: inst.updated_at,
      };

      await repo.saveInstallation(record);
      synced.push(record);

      // Associate with current user if applicable
      if (userId) {
        const matchesUsername =
          targetUser?.username &&
          inst.account?.login &&
          targetUser.username.toLowerCase() === inst.account.login.toLowerCase();

        // In single-tenant/dev mode, or if account names match, or if it's the only installation:
        if (matchesUsername || installations.length === 1 || userId.startsWith("usr_dev_") || userId === "default") {
          await repo.linkUserInstallation(userId, inst.id);
        }
      }
    }

    return synced;
  } catch (err) {
    console.warn("[github] Failed to sync installations from GitHub API:", err);
    return repo.listInstallations();
  }
}
