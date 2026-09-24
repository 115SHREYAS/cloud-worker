import { verify } from "@octokit/webhooks-methods";
import type { TaskRepository } from "../db/repository";
import type { TaskQueue } from "../queue/task-queue";
import type { GitHubTokenManager } from "./token-manager";
import type { GitHubInstallation } from "@cloud-worker/shared";

export interface HandleWebhookOptions {
  event: string;
  signature?: string;
  rawBody: string;
  secret?: string;
  repository: TaskRepository;
  taskQueue?: TaskQueue;
  tokenManager?: GitHubTokenManager;
}

export interface WebhookResult {
  handled: boolean;
  action?: string;
  message?: string;
  taskId?: string;
}

export async function handleGitHubWebhook(
  options: HandleWebhookOptions,
): Promise<WebhookResult> {
  const { event, signature, rawBody, secret, repository, taskQueue, tokenManager } = options;

  // 1. Verify signature if webhook secret is configured or fail-closed in production
  if (secret) {
    if (!signature) {
      throw new Error("Missing x-hub-signature-256 header");
    }
    const isValid = await verify(secret, rawBody, signature);
    if (!isValid) {
      throw new Error("Invalid x-hub-signature-256 signature");
    }
  } else if (process.env.NODE_ENV === "production") {
    throw new Error("GITHUB_WEBHOOK_SECRET must be configured in production");
  }

  const payload = JSON.parse(rawBody);

  // 2. Route events
  switch (event) {
    case "ping": {
      return { handled: true, action: "ping", message: payload.zen || "pong" };
    }

    case "installation": {
      const action = payload.action;
      const inst = payload.installation;

      if (!inst) {
        return { handled: false, message: "Missing installation payload" };
      }

      if (action === "created") {
        const record: GitHubInstallation = {
          id: inst.id,
          accountLogin: inst.account?.login || "unknown",
          accountType: (inst.account?.type as "User" | "Organization") || "User",
          repositorySelection: (inst.repository_selection as "all" | "selected") || "all",
          appSlug: inst.app_slug || undefined,
          createdAt: inst.created_at || new Date().toISOString(),
          updatedAt: inst.updated_at || new Date().toISOString(),
        };
        await repository.saveInstallation(record);

        if (inst.account?.id) {
          const user = await repository.getUserByGitHubId(inst.account.id);
          if (user) {
            await repository.linkUserInstallation(user.id, inst.id);
          }
        }

        return { handled: true, action: "installation.created", message: `Saved installation ${inst.id}` };
      }

      if (action === "deleted") {
        await repository.deleteInstallation(inst.id);
        return { handled: true, action: "installation.deleted", message: `Deleted installation ${inst.id}` };
      }

      return { handled: true, action: `installation.${action}`, message: `Processed ${action}` };
    }

    case "installation_repositories": {
      const action = payload.action;
      const inst = payload.installation;

      if (inst) {
        const existing = await repository.getInstallation(inst.id);
        if (existing) {
          const updated: GitHubInstallation = {
            ...existing,
            repositorySelection: (inst.repository_selection as "all" | "selected") || existing.repositorySelection,
            updatedAt: new Date().toISOString(),
          };
          await repository.saveInstallation(updated);
        }
      }
      return { handled: true, action: `installation_repositories.${action}` };
    }

    case "issue_comment": {
      const action = payload.action;
      if (action !== "created") {
        return { handled: true, action: `issue_comment.${action}` };
      }

      // Ignore comments authored by bots to prevent infinite feedback loops
      if (payload.sender?.type === "Bot" || payload.comment?.user?.type === "Bot") {
        return { handled: true, action: "issue_comment.bot_ignored" };
      }

      const commentBody: string = payload.comment?.body || "";
      const botMentionRegex = /@cloud-worker(?:\[bot\])?\s+(.+)/is;
      const match = commentBody.match(botMentionRegex);

      if (!match || !match[1]) {
        return { handled: true, action: "issue_comment.ignored", message: "No bot mention found" };
      }

      // Check author authorization (only allow owners, members, or collaborators)
      const authorAssociation: string = payload.comment?.author_association || "NONE";
      const authorizedRoles = ["OWNER", "MEMBER", "COLLABORATOR"];
      if (!authorizedRoles.includes(authorAssociation)) {
        return {
          handled: true,
          action: "issue_comment.unauthorized",
          message: `Author association '${authorAssociation}' is not authorized to dispatch tasks`,
        };
      }

      const prompt = match[1].trim();
      if (prompt.length < 5) {
        return {
          handled: true,
          action: "issue_comment.invalid_prompt",
          message: "Prompt must contain at least 5 characters",
        };
      }

      const repo = payload.repository?.name;
      const owner = payload.repository?.owner?.login;
      const defaultBranch = payload.repository?.default_branch || "main";
      const installationId = payload.installation?.id;

      if (!repo || !owner || !taskQueue) {
        return { handled: false, message: "Missing repository information or task queue" };
      }

      const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const workingBranch = `agent/patch-${taskId}`;
      const task = await repository.createTask(
        taskId,
        {
          repo: {
            owner,
            repo,
            branch: defaultBranch,
            installationId,
          },
          prompt: `Issue #${payload.issue?.number}: ${payload.issue?.title || ""}\n\nTask: ${prompt}`,
          model: "claude-3-7-sonnet-20250219",
        },
        workingBranch,
      );

      await taskQueue.enqueue(task.id);



      // Post confirmation comment if tokenManager is configured
      if (tokenManager && tokenManager.isConfigured() && installationId && payload.issue?.number) {
        try {
          const octokit = await tokenManager.getInstallationOctokit(installationId);
          await octokit.rest.issues.createComment({
            owner,
            repo,
            issue_number: payload.issue.number,
            body: `Cloud Worker agent dispatched for this task.\n- **Task ID**: \`${task.id}\`\n- **Branch**: \`${task.workingBranch}\``,
          });
        } catch (commentErr) {
          console.warn("[webhooks] Failed to post confirmation comment:", commentErr);
        }
      }

      return {
        handled: true,
        action: "issue_comment.dispatched",
        taskId: task.id,
        message: `Task ${task.id} enqueued from issue #${payload.issue?.number}`,
      };
    }

    default: {
      return { handled: true, action: event, message: `Event ${event} acknowledged` };
    }
  }
}
