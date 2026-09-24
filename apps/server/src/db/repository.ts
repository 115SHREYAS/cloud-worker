import type { StreamEvent, Task, TaskStatus, CreateTaskInput, GitHubInstallation, User, ReasoningEffort } from "@cloud-worker/shared";
import type { AgentProvider } from "@cloud-worker/sandbox";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, desc, asc, inArray, and } from "drizzle-orm";
import {
  users,
  tasks,
  taskLogs,
  authSessions,
  githubInstallations,
  userGithubInstallations,
  type UserRow,
  type TaskRow,
  type GitHubInstallationRow,
} from "./schema.ts";
import { encryptCredential, decryptCredential } from "../security/crypto.ts";

export interface TaskRecord extends Task {
  diff?: string;
  userId?: string;
}

export interface TaskRepository {
  createTask(id: string, input: CreateTaskInput, workingBranch: string, userId?: string): Promise<TaskRecord>;
  getTask(id: string): Promise<TaskRecord | null>;
  listTasks(limit?: number, userId?: string): Promise<TaskRecord[]>;
  listActiveTasks(limit?: number, userId?: string): Promise<TaskRecord[]>;
  updateTask(id: string, updates: Partial<TaskRecord>): Promise<TaskRecord>;
  saveLog(taskId: string, event: StreamEvent): Promise<void>;
  getLogs(taskId: string): Promise<StreamEvent[]>;
  saveAuthSession(provider: AgentProvider, authJson: string, userId?: string, authMode?: string): Promise<void>;
  getAuthSession(provider: AgentProvider, userId?: string): Promise<string | null>;
  getAuthSessionRecord(provider: AgentProvider, userId?: string): Promise<{ authJson: string; authMode: string; updatedAt: string } | null>;
  listAuthSessions(userId?: string): Promise<Array<{ provider: string; authMode: string; updatedAt: string }>>;
  hasAuthSession(provider: AgentProvider, userId?: string): Promise<boolean>;
  saveInstallation(installation: GitHubInstallation): Promise<void>;
  getInstallation(installationId: number): Promise<GitHubInstallation | null>;
  listInstallations(): Promise<GitHubInstallation[]>;
  deleteInstallation(installationId: number): Promise<void>;
  linkUserInstallation(userId: string, installationId: number): Promise<void>;
  listUserInstallations(userId: string): Promise<GitHubInstallation[]>;
  getUser(id: string): Promise<User | null>;
  getUserByGitHubId(githubId: number): Promise<User | null>;
  upsertUser(user: Omit<User, "createdAt" | "updatedAt">): Promise<User>;
  updateUser(id: string, updates: Partial<User>): Promise<User>;
  close(): Promise<void>;
}

function mapRowToUser(row: UserRow): User {
  return {
    id: row.id,
    githubId: row.githubId,
    username: row.username,
    email: row.email,
    avatarUrl: row.avatarUrl,
    defaultModel: row.defaultModel,
    defaultAuthMode: row.defaultAuthMode as "subscription" | "api_key",
    onboardingCompleted: row.onboardingCompleted,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapRowToTask(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    userId: row.userId ?? undefined,
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
    reasoningEffort: (row.reasoningEffort as ReasoningEffort) ?? undefined,
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
    this.client = postgres(connectionString);
    this.db = drizzle(this.client);
  }

  async createTask(id: string, input: CreateTaskInput, workingBranch: string, userId?: string): Promise<TaskRecord> {
    const now = new Date();
    const inserted = await this.db
      .insert(tasks)
      .values({
        id,
        userId: userId ?? null,
        status: "pending",
        repoOwner: input.repo.owner,
        repoName: input.repo.repo,
        repoBranch: input.repo.branch,
        repoBaseCommit: input.repo.baseCommit,
        repoInstallationId: input.repo.installationId,
        prompt: input.prompt,
        model: input.model,
        reasoningEffort: input.reasoningEffort ?? null,
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

  async listTasks(limit = 50, userId?: string): Promise<TaskRecord[]> {
    if (userId) {
      const rows = await this.db
        .select()
        .from(tasks)
        .where(eq(tasks.userId, userId))
        .orderBy(desc(tasks.createdAt))
        .limit(limit);
      return rows.map(mapRowToTask);
    }
    const rows = await this.db.select().from(tasks).orderBy(desc(tasks.createdAt)).limit(limit);
    return rows.map(mapRowToTask);
  }

  async listActiveTasks(limit = 100, userId?: string): Promise<TaskRecord[]> {
    const activeStatuses = ["pending", "provisioning", "cloning", "running"];
    if (userId) {
      const rows = await this.db
        .select()
        .from(tasks)
        .where(and(inArray(tasks.status, activeStatuses), eq(tasks.userId, userId)))
        .orderBy(asc(tasks.createdAt))
        .limit(limit);
      return rows.map(mapRowToTask);
    }
    const rows = await this.db
      .select()
      .from(tasks)
      .where(inArray(tasks.status, activeStatuses))
      .orderBy(asc(tasks.createdAt))
      .limit(limit);
    return rows.map(mapRowToTask);
  }

  async updateTask(id: string, updates: Partial<TaskRecord>): Promise<TaskRecord> {
    const values: Record<string, unknown> = {
      updatedAt: updates.updatedAt ? new Date(updates.updatedAt) : new Date(),
    };

    if (updates.createdAt !== undefined) values.createdAt = new Date(updates.createdAt);
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
    await this.db.insert(taskLogs).values({
      id: `${taskId}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
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

  async saveAuthSession(
    provider: AgentProvider,
    authJson: string,
    userId = "default",
    authMode = "subscription",
  ): Promise<void> {
    const id = `${userId}:${provider}`;
    const now = new Date();
    const encrypted = encryptCredential(authJson);

    await this.db
      .insert(authSessions)
      .values({
        id,
        userId,
        provider,
        authMode,
        authJson: encrypted.cipherText,
        iv: encrypted.iv,
        tag: encrypted.tag,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: authSessions.id,
        set: {
          authMode,
          authJson: encrypted.cipherText,
          iv: encrypted.iv,
          tag: encrypted.tag,
          updatedAt: now,
        },
      });
  }

  async getAuthSession(provider: AgentProvider, userId = "default"): Promise<string | null> {
    const record = await this.getAuthSessionRecord(provider, userId);
    return record ? record.authJson : null;
  }

  async getAuthSessionRecord(
    provider: AgentProvider,
    userId = "default",
  ): Promise<{ authJson: string; authMode: string; updatedAt: string } | null> {
    const id = `${userId}:${provider}`;
    const rows = await this.db.select().from(authSessions).where(eq(authSessions.id, id)).limit(1);
    const first = rows[0];
    if (!first) return null;

    let decrypted = first.authJson;
    if (first.iv && first.tag) {
      try {
        decrypted = decryptCredential({
          cipherText: first.authJson,
          iv: first.iv,
          tag: first.tag,
        });
      } catch {
        decrypted = first.authJson;
      }
    }

    return {
      authJson: decrypted,
      authMode: first.authMode || "subscription",
      updatedAt: first.updatedAt.toISOString(),
    };
  }

  async listAuthSessions(userId = "default"): Promise<Array<{ provider: string; authMode: string; updatedAt: string }>> {
    const rows = await this.db
      .select()
      .from(authSessions)
      .where(eq(authSessions.userId, userId))
      .orderBy(desc(authSessions.updatedAt));

    return rows.map((r) => ({
      provider: r.provider,
      authMode: r.authMode || "subscription",
      updatedAt: r.updatedAt.toISOString(),
    }));
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

  async linkUserInstallation(userId: string, installationId: number): Promise<void> {
    const id = `${userId}:${installationId}`;
    await this.db
      .insert(userGithubInstallations)
      .values({
        id,
        userId,
        installationId,
        linkedAt: new Date(),
      })
      .onConflictDoNothing();
  }

  async listUserInstallations(userId: string): Promise<GitHubInstallation[]> {
    const rows = await this.db
      .select({
        installation: githubInstallations,
      })
      .from(githubInstallations)
      .innerJoin(
        userGithubInstallations,
        eq(userGithubInstallations.installationId, githubInstallations.installationId),
      )
      .where(eq(userGithubInstallations.userId, userId))
      .orderBy(desc(githubInstallations.updatedAt));

    return rows.map((r) => mapRowToInstallation(r.installation));
  }

  async getUser(id: string): Promise<User | null> {
    const rows = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    const first = rows[0];
    return first ? mapRowToUser(first) : null;
  }

  async getUserByGitHubId(githubId: number): Promise<User | null> {
    const rows = await this.db.select().from(users).where(eq(users.githubId, githubId)).limit(1);
    const first = rows[0];
    return first ? mapRowToUser(first) : null;
  }

  async upsertUser(user: Omit<User, "createdAt" | "updatedAt">): Promise<User> {
    const now = new Date();
    const inserted = await this.db
      .insert(users)
      .values({
        id: user.id,
        githubId: user.githubId,
        username: user.username,
        email: user.email,
        avatarUrl: user.avatarUrl,
        defaultModel: user.defaultModel,
        defaultAuthMode: user.defaultAuthMode,
        onboardingCompleted: user.onboardingCompleted,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: users.githubId,
        set: {
          username: user.username,
          email: user.email,
          avatarUrl: user.avatarUrl,
          updatedAt: now,
        },
      })
      .returning();

    const first = inserted[0];
    if (!first) throw new Error("Failed to upsert user");
    return mapRowToUser(first);
  }

  async updateUser(id: string, updates: Partial<User>): Promise<User> {
    const values: Record<string, unknown> = {
      updatedAt: new Date(),
    };
    if (updates.defaultModel !== undefined) values.defaultModel = updates.defaultModel;
    if (updates.defaultAuthMode !== undefined) values.defaultAuthMode = updates.defaultAuthMode;
    if (updates.onboardingCompleted !== undefined) values.onboardingCompleted = updates.onboardingCompleted;
    if (updates.username !== undefined) values.username = updates.username;
    if (updates.email !== undefined) values.email = updates.email;
    if (updates.avatarUrl !== undefined) values.avatarUrl = updates.avatarUrl;

    const rows = await this.db.update(users).set(values).where(eq(users.id, id)).returning();
    const first = rows[0];
    if (!first) throw new Error(`User ${id} not found`);
    return mapRowToUser(first);
  }

  async close(): Promise<void> {
    await this.client.end();
  }
}

export class MemoryTaskRepository implements TaskRepository {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly logs = new Map<string, StreamEvent[]>();
  private readonly sessions = new Map<string, string>();
  private readonly sessionMeta = new Map<string, { authMode: string; updatedAt: string }>();
  private readonly installations = new Map<number, GitHubInstallation>();
  private readonly userInstallations = new Map<string, Set<number>>();
  private readonly users = new Map<string, User>();

  async createTask(id: string, input: CreateTaskInput, workingBranch: string, userId?: string): Promise<TaskRecord> {
    const now = new Date().toISOString();
    const task: TaskRecord = {
      id,
      userId,
      status: "pending",
      repo: input.repo,
      prompt: input.prompt,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
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

  async listTasks(limit = 50, userId?: string): Promise<TaskRecord[]> {
    let list = Array.from(this.tasks.values());
    if (userId) {
      list = list.filter((t) => t.userId === userId);
    }
    list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return list.slice(0, limit);
  }

  async listActiveTasks(limit = 100, userId?: string): Promise<TaskRecord[]> {
    const activeStatuses = new Set(["pending", "provisioning", "cloning", "running"]);
    let list = Array.from(this.tasks.values()).filter((t) => activeStatuses.has(t.status));
    if (userId) {
      list = list.filter((t) => t.userId === userId);
    }
    list.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
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
      updatedAt: updates.updatedAt ?? new Date().toISOString(),
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

  async saveAuthSession(
    provider: AgentProvider,
    authJson: string,
    userId = "default",
    authMode = "subscription",
  ): Promise<void> {
    const id = `${userId}:${provider}`;
    this.sessions.set(id, authJson);
    this.sessionMeta.set(id, { authMode, updatedAt: new Date().toISOString() });
  }

  async getAuthSession(provider: AgentProvider, userId = "default"): Promise<string | null> {
    const id = `${userId}:${provider}`;
    return this.sessions.get(id) ?? null;
  }

  async getAuthSessionRecord(
    provider: AgentProvider,
    userId = "default",
  ): Promise<{ authJson: string; authMode: string; updatedAt: string } | null> {
    const id = `${userId}:${provider}`;
    const authJson = this.sessions.get(id);
    if (!authJson) return null;
    const meta = this.sessionMeta.get(id) || { authMode: "subscription", updatedAt: new Date().toISOString() };
    return {
      authJson,
      authMode: meta.authMode,
      updatedAt: meta.updatedAt,
    };
  }

  async listAuthSessions(userId = "default"): Promise<Array<{ provider: string; authMode: string; updatedAt: string }>> {
    const results: Array<{ provider: string; authMode: string; updatedAt: string }> = [];
    for (const [key, val] of this.sessions.entries()) {
      const [uId, prov] = key.split(":");
      if (uId === userId && prov) {
        const meta = this.sessionMeta.get(key) || { authMode: "subscription", updatedAt: new Date().toISOString() };
        results.push({
          provider: prov,
          authMode: meta.authMode,
          updatedAt: meta.updatedAt,
        });
      }
    }
    return results;
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
    for (const set of this.userInstallations.values()) {
      set.delete(installationId);
    }
  }

  async linkUserInstallation(userId: string, installationId: number): Promise<void> {
    let set = this.userInstallations.get(userId);
    if (!set) {
      set = new Set();
      this.userInstallations.set(userId, set);
    }
    set.add(installationId);
  }

  async listUserInstallations(userId: string): Promise<GitHubInstallation[]> {
    const set = this.userInstallations.get(userId);
    if (!set) return [];
    const list: GitHubInstallation[] = [];
    for (const id of set) {
      const inst = this.installations.get(id);
      if (inst) list.push(inst);
    }
    list.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    return list;
  }

  async getUser(id: string): Promise<User | null> {
    return this.users.get(id) ?? null;
  }

  async getUserByGitHubId(githubId: number): Promise<User | null> {
    for (const u of this.users.values()) {
      if (u.githubId === githubId) return u;
    }
    return null;
  }

  async upsertUser(user: Omit<User, "createdAt" | "updatedAt">): Promise<User> {
    const existing = await this.getUserByGitHubId(user.githubId);
    const now = new Date().toISOString();
    if (existing) {
      const updated: User = {
        ...existing,
        username: user.username,
        email: user.email,
        avatarUrl: user.avatarUrl,
        updatedAt: now,
      };
      this.users.set(existing.id, updated);
      return updated;
    }

    const created: User = {
      ...user,
      createdAt: now,
      updatedAt: now,
    };
    this.users.set(user.id, created);
    return created;
  }

  async updateUser(id: string, updates: Partial<User>): Promise<User> {
    const existing = this.users.get(id);
    if (!existing) throw new Error(`User ${id} not found`);
    const updated: User = {
      ...existing,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    this.users.set(id, updated);
    return updated;
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
