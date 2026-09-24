import { describe, it, expect } from "bun:test";
import { encryptCredential, decryptCredential } from "./security/crypto.ts";
import { createSessionToken, verifySessionToken, createSessionCookie, parseCookies } from "./security/session.ts";
import { MemoryTaskRepository } from "./db/repository.ts";
import { MemoryEventBus } from "./events/event-bus.ts";
import { DirectTaskQueue } from "./queue/task-queue.ts";
import { TaskWorker } from "./queue/task-worker.ts";
import { createServer } from "./server.ts";

describe("User Authentication & Onboarding Controls", () => {
  it("encrypts and decrypts credentials with AES-256-GCM integrity checks", () => {
    const secretApiKey = "sk-proj-super-secret-openai-api-key-12345678";
    const encrypted = encryptCredential(secretApiKey);

    expect(encrypted.cipherText).not.toBe(secretApiKey);
    expect(encrypted.iv).toBeDefined();
    expect(encrypted.tag).toBeDefined();

    const decrypted = decryptCredential(encrypted);
    expect(decrypted).toBe(secretApiKey);

    // Tampered ciphertext must throw on authentication tag check
    const tampered = {
      ...encrypted,
      cipherText: encrypted.cipherText.slice(0, -2) + "00",
    };
    expect(() => decryptCredential(tampered)).toThrow();
  });

  it("creates, verifies, and parses signed session tokens and cookies", () => {
    const payload = {
      sub: "usr_998877",
      username: "alex-developer",
      email: "alex@example.com",
      avatarUrl: "https://github.com/alex.png",
    };

    const token = createSessionToken(payload, "test-secret-32-character-length!!", 3600);
    const verified = verifySessionToken(token, "test-secret-32-character-length!!");

    expect(verified).not.toBeNull();
    expect(verified?.sub).toBe("usr_998877");
    expect(verified?.username).toBe("alex-developer");

    // Cookie serialization
    const cookieHeader = createSessionCookie(token, 3600, false);
    expect(cookieHeader).toContain("cw_session=");
    expect(cookieHeader).toContain("HttpOnly");

    const parsed = parseCookies(cookieHeader);
    expect(parsed.cw_session).toBe(token);
  });

  it("scopes tasks per user in repository", async () => {
    const repo = new MemoryTaskRepository();

    // Create tasks for User 1
    await repo.createTask(
      "task-u1",
      { repo: { owner: "u1", repo: "repo1", branch: "main" }, prompt: "p1", model: "codex" },
      "patch-1",
      "usr_1",
    );

    // Create tasks for User 2
    await repo.createTask(
      "task-u2",
      { repo: { owner: "u2", repo: "repo2", branch: "main" }, prompt: "p2", model: "codex" },
      "patch-2",
      "usr_2",
    );

    // User 1 only sees their tasks
    const u1Tasks = await repo.listTasks(50, "usr_1");
    expect(u1Tasks.length).toBe(1);
    expect(u1Tasks[0]?.id).toBe("task-u1");

    // User 2 only sees their tasks
    const u2Tasks = await repo.listTasks(50, "usr_2");
    expect(u2Tasks.length).toBe(1);
    expect(u2Tasks[0]?.id).toBe("task-u2");
  });

  it("manages user onboarding lifecycle and credential saving via HTTP API", async () => {
    const repo = new MemoryTaskRepository();
    const eventBus = new MemoryEventBus();
    const worker = new TaskWorker(repo, eventBus);
    const queue = new DirectTaskQueue(worker);

    const server = createServer({
      port: 0,
      repo,
      eventBus,
      queue,
    });

    const baseUrl = `http://localhost:${server.port}`;

    try {
      // 1. Dev login
      const loginRes = await fetch(`${baseUrl}/api/auth/dev-login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "testuser", email: "test@example.com" }),
      });
      expect(loginRes.status).toBe(200);
      const loginData = (await loginRes.json()) as { ok: boolean; token: string; user: { id: string; onboardingCompleted: boolean } };
      expect(loginData.ok).toBe(true);
      expect(loginData.user.onboardingCompleted).toBe(false);

      const authHeaders = {
        Authorization: `Bearer ${loginData.token}`,
        "Content-Type": "application/json",
      };

      // 2. Check /api/auth/me
      const meRes = await fetch(`${baseUrl}/api/auth/me`, { headers: authHeaders });
      expect(meRes.status).toBe(200);
      const meData = (await meRes.json()) as { user: { username: string } };
      expect(meData.user.username).toBe("testuser");

      // 3. Save agent credentials
      const credRes = await fetch(`${baseUrl}/api/user/credentials`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          provider: "codex",
          authMode: "subscription",
          credential: '{"tokens":{"access_token":"mock_access_token"}}',
        }),
      });
      expect(credRes.status).toBe(200);

      // 4. Update onboarding progress
      const onboardingRes = await fetch(`${baseUrl}/api/user/onboarding`, {
        method: "PATCH",
        headers: authHeaders,
        body: JSON.stringify({
          onboardingCompleted: true,
          defaultModel: "codex",
          defaultAuthMode: "subscription",
        }),
      });
      expect(onboardingRes.status).toBe(200);
      const onboardingData = (await onboardingRes.json()) as { ok: boolean; user: { onboardingCompleted: boolean } };
      expect(onboardingData.user.onboardingCompleted).toBe(true);

      // 5. Get user settings
      const settingsRes = await fetch(`${baseUrl}/api/user/settings`, { headers: authHeaders });
      expect(settingsRes.status).toBe(200);
      const settingsData = (await settingsRes.json()) as {
        user: { onboardingCompleted: boolean };
        configuredProviders: Array<{ provider: string; authMode: string }>;
      };
      expect(settingsData.user.onboardingCompleted).toBe(true);
      expect(settingsData.configuredProviders.length).toBeGreaterThanOrEqual(1);
      expect(settingsData.configuredProviders.some((p) => p.provider === "codex")).toBe(true);
    } finally {
      server.stop();
    }
  });
});
