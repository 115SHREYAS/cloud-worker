import type { StreamEvent, Task, TaskStatus, CreateTaskInput, GitHubInstallation } from "@cloud-worker/shared";
import type { AgentProvider } from "@cloud-worker/sandbox";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, desc, asc } from "drizzle-orm";
import {
  tasks,
  taskLogs,
  authSessions,
  githubInstallations,
  type TaskRow,
  type GitHubInstallationRow,
} from "./schema.ts";

export interface TaskRecord extends Task {
  diff?: string;
}

export interface TaskRepository {
  createTask(id: string, input: CreateTaskInput, workingBranch: string): Promise<TaskRecord>;
  getTask(id: string): Promise<TaskRecord | null>;
  listTasks(limit?: number): Promise<TaskRecord[]>;
  updateTask(id: string, updates: Partial<TaskRecord>): Promise<TaskRecord>;
  saveLog(taskId: string, event: StreamEvent): Promise<void>;
  getLogs(taskId: string): Promise<StreamEvent[]>;
  saveAuthSession(provider: AgentProvider, authJson: string, userId?: string): Promise<void>;
  getAuthSession(provider: AgentProvider, userId?: string): Promise<string | null>;
  hasAuthSession(provider: AgentProvider, userId?: string): Promise<boolean>;
  saveInstallation(installation: GitHubInstallation): Promise<void>;
  getInstallation(installationId: number): Promise<GitHubInstallation | null>;
  listInstallations(): Promise<GitHubInstallation[]>;
  deleteInstallation(installationId: number): Promise<void>;
  close(): Promise<void>;
}


function mapRowToTask(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    status: row.status as TaskStatus,
    repo: {
      owner: row.repoOwner,
      repo: row.repoName,
      branch: row.repoBranch,
      baseCommit: row.repoBaseCommit ?? undefined,
      installationId: row.repoInstallationId ?? undefined,
    },
    prompt: row.prompt,
    model: row.model,
    workingBranch: row.workingBranch,
    sandboxId: row.sandboxId ?? undefined,
    pullRequestUrl: row.pullRequestUrl ?? undefined,
    diff: row.diff ?? undefined,
    tokenUsage:
      row.tokenInputTokens !== null && row.tokenOutputTokens !== null && row.tokenTotalTokens !== null
        ? {
            inputTokens: row.tokenInputTokens,
            outputTokens: row.tokenOutputTokens,
            totalTokens: row.tokenTotalTokens,
            estimatedCostUsd: row.tokenEstimatedCostUsd ?? undefined,
          }
        : undefined,
    error: row.error ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : undefined,
  };
}

function mapRowToInstallation(row: GitHubInstallationRow): GitHubInstallation {
  return {
    id: row.installationId,
    accountLogin: row.accountLogin,
    accountType: row.accountType as "User" | "Organization",
    repositorySelection: row.repositorySelection as "all" | "selected",
    appSlug: row.appSlug ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class DrizzleTaskRepository implements TaskRepository {
  private readonly db;
  private readonly client: postgres.Sql;

  constructor(connectionString: string) {
    this.client = postgres(connectionString, { max: 10, idle_timeout: 20 });
    this.db = drizzle(this.client, { schema: { tasks, taskLogs, authSessions, githubInstallations } });
  }


  async createTask(id: string, input: CreateTaskInput, workingBranch: string): Promise<TaskRecord> {
    const now = new Date();
    const inserted = await this.db
      .insert(tasks)
      .values({
        id,
        status: "pending",
        repoOwner: input.repo.owner,
        repoName: input.repo.repo,
        repoBranch: input.repo.branch,
        repoBaseCommit: input.repo.baseCommit,
        repoInstallationId: input.repo.installationId,
        prompt: input.prompt,
        model: input.model,
        workingBranch,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    const first = inserted[0];
    if (!first) {
      throw new Error(`Failed to insert task ${id}`);
    }
    return mapRowToTask(first);
  }

  async getTask(id: string): Promise<TaskRecord | null> {
    const rows = await this.db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
    const first = rows[0];
    return first ? mapRowToTask(first) : null;
  }

  async listTasks(limit = 50): Promise<TaskRecord[]> {
    const rows = await this.db.select().from(tasks).orderBy(desc(tasks.createdAt)).limit(limit);
    return rows.map(mapRowToTask);
  }

  async updateTask(id: string, updates: Partial<TaskRecord>): Promise<TaskRecord> {
    const values: Record<string, unknown> = {
      updatedAt: new Date(),
    };

    if (updates.status !== undefined) values.status = updates.status;
    if (updates.sandboxId !== undefined) values.sandboxId = updates.sandboxId;
    if (updates.pullRequestUrl !== undefined) values.pullRequestUrl = updates.pullRequestUrl;
    if (updates.diff !== undefined) values.diff = updates.diff;
    if (updates.error !== undefined) values.error = updates.error;
    if (updates.completedAt !== undefined) {
      values.completedAt = updates.completedAt ? new Date(updates.completedAt) : null;
    }
    if (updates.tokenUsage) {
      values.tokenInputTokens = updates.tokenUsage.inputTokens;
      values.tokenOutputTokens = updates.tokenUsage.outputTokens;
      values.tokenTotalTokens = updates.tokenUsage.totalTokens;
      values.tokenEstimatedCostUsd = updates.tokenUsage.estimatedCostUsd;
    }

    const updated = await this.db
      .update(tasks)
      .set(values)
      .where(eq(tasks.id, id))
      .returning();

    const first = updated[0];
    if (!first) {
      throw new Error(`Task ${id} not found to update`);
    }
    return mapRowToTask(first);
  }

  async saveLog(taskId: string, event: StreamEvent): Promise<void> {
    const logId = `log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await this.db.insert(taskLogs).values({
      id: logId,
      taskId,
      eventType: event.type,
      payload: event,
      createdAt: new Date(),
    });
  }

  async getLogs(taskId: string): Promise<StreamEvent[]> {
    const rows = await this.db
      .select()
      .from(taskLogs)
      .where(eq(taskLogs.taskId, taskId))
      .orderBy(asc(taskLogs.createdAt), asc(taskLogs.id));

    return rows.map((r) => r.payload as StreamEvent);
  }

  async saveAuthSession(provider: AgentProvider, authJson: string, userId = "default"): Promise<void> {
    const id = `${userId}:${provider}`;
    const now = new Date();
    await this.db
      .insert(authSessions)
      .values({
        id,
        userId,
        provider,
        authJson,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: authSessions.id,
        set: {
          authJson,
          updatedAt: now,
        },
      });
  }

  async getAuthSession(provider: AgentProvider, userId = "default"): Promise<string | null> {
    const id = `${userId}:${provider}`;
    const rows = await this.db.select().from(authSessions).where(eq(authSessions.id, id)).limit(1);
    const first = rows[0];
    return first ? first.authJson : null;
  }

  async hasAuthSession(provider: AgentProvider, userId = "default"): Promise<boolean> {
    const session = await this.getAuthSession(provider, userId);
    return session !== null && session.trim().length > 0;
  }

  async saveInstallation(installation: GitHubInstallation): Promise<void> {
    const id = String(installation.id);
    const now = new Date();
    await this.db
      .insert(githubInstallations)
      .values({
        id,
        installationId: installation.id,
        accountLogin: installation.accountLogin,
        accountType: installation.accountType,
        repositorySelection: installation.repositorySelection,
        appSlug: installation.appSlug,
        createdAt: new Date(installation.createdAt),
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: githubInstallations.installationId,
        set: {
          accountLogin: installation.accountLogin,
          accountType: installation.accountType,
          repositorySelection: installation.repositorySelection,
          appSlug: installation.appSlug,
          updatedAt: now,
        },
      });
  }

  async getInstallation(installationId: number): Promise<GitHubInstallation | null> {
    const rows = await this.db
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.installationId, installationId))
      .limit(1);
    const first = rows[0];
    return first ? mapRowToInstallation(first) : null;
  }

  async listInstallations(): Promise<GitHubInstallation[]> {
    const rows = await this.db
      .select()
      .from(githubInstallations)
      .orderBy(desc(githubInstallations.updatedAt));
    return rows.map(mapRowToInstallation);
  }

  async deleteInstallation(installationId: number): Promise<void> {
    await this.db
      .delete(githubInstallations)
      .where(eq(githubInstallations.installationId, installationId));
  }

  async close(): Promise<void> {
    await this.client.end();
  }
}


export class MemoryTaskRepository implements TaskRepository {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly logs = new Map<string, StreamEvent[]>();
  private readonly sessions = new Map<string, string>();
  private readonly installations = new Map<number, GitHubInstallation>();


  async createTask(id: string, input: CreateTaskInput, workingBranch: string): Promise<TaskRecord> {
    const now = new Date().toISOString();
    const task: TaskRecord = {
      id,
      status: "pending",
      repo: input.repo,
      prompt: input.prompt,
      model: input.model,
      workingBranch,
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(id, task);
    this.logs.set(id, []);
    return task;
  }

  async getTask(id: string): Promise<TaskRecord | null> {
    return this.tasks.get(id) ?? null;
  }

  async listTasks(limit = 50): Promise<TaskRecord[]> {
    const list = Array.from(this.tasks.values());
    list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return list.slice(0, limit);
  }

  async updateTask(id: string, updates: Partial<TaskRecord>): Promise<TaskRecord> {
    const existing = this.tasks.get(id);
    if (!existing) {
      throw new Error(`Task ${id} not found`);
    }
    const updated: TaskRecord = {
      ...existing,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    this.tasks.set(id, updated);
    return updated;
  }

  async saveLog(taskId: string, event: StreamEvent): Promise<void> {
    const list = this.logs.get(taskId) ?? [];
    list.push(event);
    this.logs.set(taskId, list);
  }

  async getLogs(taskId: string): Promise<StreamEvent[]> {
    return this.logs.get(taskId) ?? [];
  }

  async saveAuthSession(provider: AgentProvider, authJson: string, userId = "default"): Promise<void> {
    const id = `${userId}:${provider}`;
    this.sessions.set(id, authJson);
  }

  async getAuthSession(provider: AgentProvider, userId = "default"): Promise<string | null> {
    const id = `${userId}:${provider}`;
    return this.sessions.get(id) ?? null;
  }

  async hasAuthSession(provider: AgentProvider, userId = "default"): Promise<boolean> {
    const id = `${userId}:${provider}`;
    const session = this.sessions.get(id);
    return session !== undefined && session.trim().length > 0;
  }

  async saveInstallation(installation: GitHubInstallation): Promise<void> {
    this.installations.set(installation.id, {
      ...installation,
      updatedAt: new Date().toISOString(),
    });
  }

  async getInstallation(installationId: number): Promise<GitHubInstallation | null> {
    return this.installations.get(installationId) ?? null;
  }

  async listInstallations(): Promise<GitHubInstallation[]> {
    const list = Array.from(this.installations.values());
    list.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    return list;
  }

  async deleteInstallation(installationId: number): Promise<void> {
    this.installations.delete(installationId);
  }

  async close(): Promise<void> {
    // No-op for memory repository
  }

}

export async function createTaskRepository(connectionString?: string): Promise<TaskRepository> {
  const url = connectionString ?? process.env.DATABASE_URL;
  if (!url) {
    console.log("[db] DATABASE_URL not set. Using MemoryTaskRepository.");
    return new MemoryTaskRepository();
  }

  try {
    // Test connection with short timeout before creating repository pool
    const testClient = postgres(url, { max: 1, timeout: 2 });
    await testClient`SELECT 1`;
    await testClient.end();

    const repo = new DrizzleTaskRepository(url);
    console.log("[db] Connected to PostgreSQL with Drizzle ORM.");
    return repo;
  } catch (err) {
    console.warn("[db] PostgreSQL connection failed. Falling back to MemoryTaskRepository:", err);
    return new MemoryTaskRepository();
  }
}
