import type {
  CreateTaskInput,
  Task,
  StreamEvent,
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
