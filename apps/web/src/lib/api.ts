import type {
  CreateTaskInput,
  Task,
  StreamEvent,
  GitHubInstallation,
  GitHubRepository,
  UserPublicProfile,
  SaveCredentialsInput,
  UpdateOnboardingInput,
  UserSettings,
  ModelOption,
} from "@cloud-worker/shared";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "";

export async function fetchTasks(limit = 50): Promise<Task[]> {
  const res = await fetch(`${API_BASE}/api/tasks?limit=${limit}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch tasks: ${res.statusText}`);
  }
  const data = (await res.json()) as { tasks: Task[] };
  return data.tasks;
}

export async function fetchTask(id: string): Promise<Task> {
  const res = await fetch(`${API_BASE}/api/tasks/${id}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch task ${id}: ${res.statusText}`);
  }
  const data = (await res.json()) as { task: Task };
  return data.task;
}

export async function createTask(input: CreateTaskInput): Promise<Task> {
  const res = await fetch(`${API_BASE}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to create task: ${res.statusText}`);
  }

  const data = (await res.json()) as { task: Task };
  return data.task;
}

export async function cancelTask(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/tasks/${id}/cancel`, {
    method: "POST",
  });
  if (!res.ok) {
    throw new Error(`Failed to cancel task ${id}: ${res.statusText}`);
  }
}

export async function fetchTaskLogs(id: string): Promise<StreamEvent[]> {
  const res = await fetch(`${API_BASE}/api/tasks/${id}/logs`);
  if (!res.ok) {
    throw new Error(`Failed to fetch logs for task ${id}: ${res.statusText}`);
  }
  const data = (await res.json()) as { logs: StreamEvent[] };
  return data.logs;
}

export async function fetchAuthStatus(
  provider: "codex" | "claude",
): Promise<{ provider: string; configured: boolean }> {
  const res = await fetch(`${API_BASE}/api/auth/session/${provider}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch auth status for ${provider}`);
  }
  return res.json();
}

export async function saveAuthSession(
  provider: "codex" | "claude",
  authJson: string,
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/auth/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, authJson }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to save auth session`);
  }
}

export async function fetchGitHubStatus(): Promise<{
  configured: boolean;
  appId?: number;
  appSlug?: string;
  installUrl?: string;
}> {
  const res = await fetch(`${API_BASE}/api/github/status`);
  if (!res.ok) {
    throw new Error("Failed to fetch GitHub App status");
  }
  return res.json();
}

export async function fetchGitHubInstallations(): Promise<GitHubInstallation[]> {
  const res = await fetch(`${API_BASE}/api/github/installations`);
  if (!res.ok) {
    throw new Error("Failed to fetch GitHub App installations");
  }
  const data = (await res.json()) as { installations?: GitHubInstallation[] };
  return data.installations || [];
}

export async function fetchGitHubRepositories(installationId?: number): Promise<GitHubRepository[]> {
  const url = installationId
    ? `${API_BASE}/api/github/repositories?installationId=${installationId}`
    : `${API_BASE}/api/github/repositories`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error("Failed to fetch GitHub repositories");
  }
  const data = (await res.json()) as { repositories?: GitHubRepository[] };
  return data.repositories || [];
}

export interface GitHubBranch {
  name: string;
  protected?: boolean;
}

export async function fetchGitHubBranches(
  owner: string,
  repo: string,
  installationId?: number,
): Promise<GitHubBranch[]> {
  const params = new URLSearchParams({ owner, repo });
  if (installationId) {
    params.set("installationId", String(installationId));
  }
  try {
    const res = await fetch(`${API_BASE}/api/github/branches?${params.toString()}`);
    if (!res.ok) {
      return [{ name: "main", protected: false }];
    }
    const data = (await res.json()) as { branches?: GitHubBranch[] };
    return data.branches || [{ name: "main", protected: false }];
  } catch {
    return [{ name: "main", protected: false }];
  }
}

export async function linkGitHubInstallation(installationId: number): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/api/github/installations/link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ installationId }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function getCurrentUser(): Promise<UserPublicProfile | null> {
  const res = await fetch(`${API_BASE}/api/auth/me`);
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      return null;
    }
    throw new Error(`Failed to fetch current user: ${res.statusText}`);
  }
  const data = (await res.json()) as { user: UserPublicProfile };
  return data.user;
}

export async function devLogin(username?: string, email?: string): Promise<UserPublicProfile> {
  const res = await fetch(`${API_BASE}/api/auth/dev-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, email }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to log in: ${res.statusText}`);
  }
  const data = (await res.json()) as { user: UserPublicProfile };
  return data.user;
}

export async function logout(): Promise<void> {
  const res = await fetch(`${API_BASE}/api/auth/logout`, {
    method: "POST",
  });
  if (!res.ok) {
    throw new Error(`Failed to log out: ${res.statusText}`);
  }
}

export async function getUserSettings(): Promise<UserSettings> {
  const res = await fetch(`${API_BASE}/api/user/settings`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to fetch user settings`);
  }
  return res.json() as Promise<UserSettings>;
}

export async function saveUserCredentials(input: SaveCredentialsInput): Promise<void> {
  const res = await fetch(`${API_BASE}/api/user/credentials`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to save credentials`);
  }
}

export async function updateOnboarding(input: UpdateOnboardingInput): Promise<UserPublicProfile> {
  const res = await fetch(`${API_BASE}/api/user/onboarding`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to update onboarding`);
  }
  const data = (await res.json()) as { user: UserPublicProfile };
  return data.user;
}

export interface DetectedProviderAuth {
  provider: "codex" | "claude";
  available: boolean;
  source: string;
  planName?: string;
  hasToken: boolean;
  email?: string;
}

export interface ProviderAuthFlow {
  id: string;
  provider: "codex" | "claude";
  userId: string;
  phase: "starting" | "waiting_for_user" | "verifying" | "succeeded" | "failed" | "cancelled";
  authorizationUrl?: string;
  userCode?: string;
  message?: string;
  error?: string;
  createdAt: number;
  expiresAt: number;
}

export async function detectLocalProviderCredentials(): Promise<DetectedProviderAuth[]> {
  try {
    const res = await fetch(`${API_BASE}/api/auth/provider/detect`);
    if (!res.ok) return [];
    const data = (await res.json()) as { detected?: DetectedProviderAuth[] };
    return data.detected || [];
  } catch {
    return [];
  }
}

export async function importLocalProviderCredentials(provider: "codex" | "claude"): Promise<{ ok: boolean; provider: string }> {
  const res = await fetch(`${API_BASE}/api/auth/provider/import-local`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || "Failed to import local credentials");
  }
  return res.json();
}

export async function startProviderLoginFlow(provider: "codex" | "claude"): Promise<{ flow: ProviderAuthFlow }> {
  const res = await fetch(`${API_BASE}/api/auth/provider/start-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || "Failed to start sign-in flow");
  }
  return res.json();
}

export async function fetchProviderFlowStatus(flowId: string): Promise<{ flow: ProviderAuthFlow }> {
  const res = await fetch(`${API_BASE}/api/auth/provider/flow/${flowId}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || "Failed to fetch flow status");
  }
  return res.json();
}

export async function cancelProviderLoginFlow(flowId: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${API_BASE}/api/auth/provider/cancel-flow`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ flowId }),
  });
  return res.json().catch(() => ({ ok: false }));
}

export async function fetchAvailableModels(
  harness?: "codex" | "claude",
): Promise<ModelOption[]> {
  try {
    const url = harness
      ? `${API_BASE}/api/models?harness=${harness}`
      : `${API_BASE}/api/models`;
    const res = await fetch(url);
    if (!res.ok) {
      return [];
    }
    const data = (await res.json()) as { models: ModelOption[] };
    return data.models || [];
  } catch {
    return [];
  }
}




