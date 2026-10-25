import { MemoryTaskRepository } from "./db/repository.ts";
import { MemoryEventBus } from "./events/event-bus.ts";
import { TaskWorker } from "./queue/task-worker.ts";
import { DirectTaskQueue } from "./queue/task-queue.ts";
import { createServer } from "./server.ts";
import { createSessionToken } from "./security/session.ts";
import { StreamEventSchema, type StreamEvent } from "@cloud-worker/shared";

async function runTests() {
  console.log("=== Phase 3 Server Verification ===");

  const TEST_PORT = 3099;
  const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

  const repo = new MemoryTaskRepository();
  const eventBus = new MemoryEventBus();
  const worker = new TaskWorker(repo, eventBus);
  const queue = new DirectTaskQueue(worker);

  const server = createServer({
    port: TEST_PORT,
    repo,
    eventBus,
    queue,
    worker,
  });

  console.log(`Test server running at ${BASE_URL}`);

  try {
    // 1. Health check
    console.log("\n1. Testing GET /health...");
    const healthRes = await fetch(`${BASE_URL}/health`);
    if (!healthRes.ok) throw new Error(`Health check failed: ${healthRes.status}`);
    const healthData = (await healthRes.json()) as { status: string; service: string };
    console.log("Health response:", healthData);
    if (healthData.status !== "ok" || healthData.service !== "cloud-worker-server") {
      throw new Error("Unexpected health response");
    }

    // 1b. Mint session tokens for authenticated requests
    console.log("\n1b. Minting session tokens for two test users...");
    const sessionToken = createSessionToken({
      sub: "usr_test_runner_1",
      githubId: 90001,
      username: "test-runner",
      email: "test-runner@example.com",
      avatarUrl: "https://github.com/test-runner.png",
    });
    const authHeaders = { Authorization: `Bearer ${sessionToken}` };
    const testUserId = "usr_test_runner_1";

    const otherToken = createSessionToken({
      sub: "usr_test_runner_2",
      githubId: 90002,
      username: "other-runner",
      email: "other-runner@example.com",
      avatarUrl: "https://github.com/other-runner.png",
    });
    const otherAuthHeaders = { Authorization: `Bearer ${otherToken}` };

    // 1c. Unauthenticated requests must be rejected with 401
    console.log("\n1c. Testing unauthenticated access is denied...");
    const anonListRes = await fetch(`${BASE_URL}/api/tasks`);
    if (anonListRes.status !== 401) {
      throw new Error(`Expected 401 for unauthenticated task list, got ${anonListRes.status}`);
    }
    const anonCreateRes = await fetch(`${BASE_URL}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: { owner: "o", repo: "r", branch: "main" }, prompt: "x", model: "codex" }),
    });
    if (anonCreateRes.status !== 401) {
      throw new Error(`Expected 401 for unauthenticated task creation, got ${anonCreateRes.status}`);
    }
    console.log("Unauthenticated access correctly rejected with 401");

    // 2. Save auth session
    console.log("\n2. Testing POST /api/auth/session...");
    const authPayload = {
      provider: "codex",
      authJson: JSON.stringify({ token: "test-oauth-token-subscription", expiresAt: 9999999999 }),
    };
    const authRes = await fetch(`${BASE_URL}/api/auth/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify(authPayload),
    });
    if (!authRes.ok) throw new Error(`Auth save failed: ${authRes.status}`);
    const authSaveData = (await authRes.json()) as { success: boolean; provider: string };
    console.log("Auth save response:", authSaveData);
    if (!authSaveData.success || authSaveData.provider !== "codex") {
      throw new Error("Unexpected auth save response");
    }

    // 3. Check auth session status
    console.log("\n3. Testing GET /api/auth/session/:provider...");
    const codexCheckRes = await fetch(`${BASE_URL}/api/auth/session/codex`, { headers: authHeaders });
    const codexCheck = (await codexCheckRes.json()) as { provider: string; configured: boolean };
    console.log("Codex check:", codexCheck);
    if (!codexCheck.configured) {
      throw new Error("Codex auth should be configured");
    }

    const claudeCheckRes = await fetch(`${BASE_URL}/api/auth/session/claude`, { headers: authHeaders });
    const claudeCheck = (await claudeCheckRes.json()) as { provider: string; configured: boolean };
    console.log("Claude check:", claudeCheck);
    if (claudeCheck.configured) {
      throw new Error("Claude auth should not be configured yet");
    }

    // 4. Create Task
    console.log("\n4. Testing POST /api/tasks...");
    const createTaskPayload = {
      repo: {
        owner: "acme-corp",
        repo: "payment-service",
        branch: "main",
      },
      prompt: "Implement idempotent retry mechanism in payment checkout service",
      model: "codex",
    };

    const createRes = await fetch(`${BASE_URL}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify(createTaskPayload),
    });
    if (!createRes.ok) throw new Error(`Create task failed: ${createRes.status}`);
    const createData = (await createRes.json()) as { task: { id: string; status: string; workingBranch: string } };
    const taskId = createData.task.id;
    console.log(`Created task ID: ${taskId}, status: ${createData.task.status}`);
    if (!taskId || !createData.task.workingBranch.startsWith("agent/patch-")) {
      throw new Error("Invalid task response from POST /api/tasks");
    }

    // 5. Get Task
    console.log("\n5. Testing GET /api/tasks/:id...");
    const getRes = await fetch(`${BASE_URL}/api/tasks/${taskId}`, { headers: authHeaders });
    if (!getRes.ok) throw new Error(`Get task failed: ${getRes.status}`);
    const getData = (await getRes.json()) as { task: { id: string; prompt: string } };
    console.log("Retrieved task prompt:", getData.task.prompt);
    if (getData.task.id !== taskId) {
      throw new Error("Mismatch in retrieved task ID");
    }

    // 6. List Tasks
    console.log("\n6. Testing GET /api/tasks...");
    const listRes = await fetch(`${BASE_URL}/api/tasks?limit=10`, { headers: authHeaders });
    if (!listRes.ok) throw new Error(`List tasks failed: ${listRes.status}`);
    const listData = (await listRes.json()) as { tasks: Array<{ id: string }> };
    console.log(`Found ${listData.tasks.length} tasks in list`);
    if (!listData.tasks.some((t) => t.id === taskId)) {
      throw new Error("Created task not present in list");
    }

    // 7. Test SSE Stream
    console.log("\n7. Testing GET /api/tasks/:id/stream (SSE)...");
    const streamRes = await fetch(`${BASE_URL}/api/tasks/${taskId}/stream`, { headers: authHeaders });
    if (!streamRes.ok) throw new Error(`Stream request failed: ${streamRes.status}`);
    if (!streamRes.headers.get("content-type")?.includes("text/event-stream")) {
      throw new Error("Response is not text/event-stream");
    }

    const reader = streamRes.body?.getReader();
    if (!reader) throw new Error("No readable stream available");

    const decoder = new TextDecoder();
    const receivedEvents: StreamEvent[] = [];

    // Publish test events to event bus
    const testEvents: StreamEvent[] = [
      {
        type: "stdout",
        taskId,
        data: "[codex] Initializing model context and loading workspace...",
        timestamp: Date.now(),
      },
      {
        type: "thought",
        taskId,
        thought: "I need to inspect the retry configuration in src/checkout.ts",
        timestamp: Date.now(),
      },
      {
        type: "diff",
        taskId,
        diff: "--- a/src/checkout.ts\n+++ b/src/checkout.ts\n@@ -1,3 +1,4 @@\n+import { retry } from './retry';",
        timestamp: Date.now(),
      },
    ];

    // Read from SSE stream in background
    const readStreamPromise = (async () => {
      let buffer = "";
      while (receivedEvents.length < testEvents.length) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";

        for (const part of parts) {
          const trimmed = part.trim();
          if (trimmed.startsWith("data: ")) {
            const jsonStr = trimmed.slice(6);
            const parsed = StreamEventSchema.parse(JSON.parse(jsonStr));
            receivedEvents.push(parsed);
          }
        }
      }
    })();

    // Emit test events with small delay
    await new Promise((r) => setTimeout(r, 50));
    for (const event of testEvents) {
      await eventBus.publish(event);
      await new Promise((r) => setTimeout(r, 20));
    }

    // Wait for reader to catch all events or timeout after 3s
    await Promise.race([
      readStreamPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("SSE stream reading timed out")), 3000)),
    ]);

    await reader.cancel();
    console.log(`Received ${receivedEvents.length} SSE stream events:`);
    for (const evt of receivedEvents) {
      console.log(`  - [${evt.type}]`, "data" in evt ? evt.data : "thought" in evt ? evt.thought : "diff" in evt ? "diff received" : "");
    }
    if (receivedEvents.length < 3) {
      throw new Error(`Expected at least 3 events, received ${receivedEvents.length}`);
    }

    // 8. Test Cancel Task
    console.log("\n8. Testing POST /api/tasks/:id/cancel...");
    const cancelRes = await fetch(`${BASE_URL}/api/tasks/${taskId}/cancel`, { method: "POST", headers: authHeaders });
    if (!cancelRes.ok) throw new Error(`Cancel request failed: ${cancelRes.status}`);
    const cancelData = (await cancelRes.json()) as { success: boolean; taskId: string };
    console.log("Cancel response:", cancelData);
    if (!cancelData.success || cancelData.taskId !== taskId) {
      throw new Error("Task cancellation failed");
    }

    const cancelledTask = await repo.getTask(taskId);
    console.log("Final task status in repo:", cancelledTask?.status);
    if (cancelledTask?.status !== "cancelled") {
      throw new Error(`Expected status to be cancelled, got ${cancelledTask?.status}`);
    }

    // 9. Test Follow-up Prompt Endpoint
    console.log("\n9. Testing POST /api/tasks/:id/prompt...");
    const fuTaskId = "task_followup_test";
    await repo.createTask(fuTaskId, createTaskPayload, "agent/patch-fu", testUserId);
    await repo.updateTask(fuTaskId, { status: "waiting_input" });

    const promptRes = await fetch(`${BASE_URL}/api/tasks/${fuTaskId}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({ prompt: "Add comprehensive integration tests" }),
    });
    if (!promptRes.ok) throw new Error(`Follow-up prompt request failed: ${promptRes.status}`);
    const promptData = (await promptRes.json()) as { success: boolean; queued: boolean; message: string };
    console.log("Follow-up prompt response:", promptData);
    if (!promptData.success) {
      throw new Error("Expected prompt submission to succeed");
    }

    // 10. Test Finish Session Endpoint
    console.log("\n10. Testing POST /api/tasks/:id/finish...");
    const finishRes = await fetch(`${BASE_URL}/api/tasks/${fuTaskId}/finish`, {
      method: "POST",
      headers: authHeaders,
    });
    if (!finishRes.ok) throw new Error(`Finish request failed: ${finishRes.status}`);
    const finishData = (await finishRes.json()) as { success: boolean };
    console.log("Finish response:", finishData);
    if (!finishData.success) {
      throw new Error("Expected finish request to succeed");
    }

    // 11. Cross-user isolation: another authenticated user cannot access the task
    console.log("\n11. Testing cross-user task isolation...");
    const crossRes = await fetch(`${BASE_URL}/api/tasks/${taskId}`, { headers: otherAuthHeaders });
    if (crossRes.status !== 404) {
      throw new Error(`Expected 404 for cross-user task access, got ${crossRes.status}`);
    }
    const crossListRes = await fetch(`${BASE_URL}/api/tasks`, { headers: otherAuthHeaders });
    if (!crossListRes.ok) throw new Error(`Cross-user task list failed: ${crossListRes.status}`);
    const crossListData = (await crossListRes.json()) as { tasks: Array<{ id: string }> };
    if (crossListData.tasks.some((t) => t.id === taskId)) {
      throw new Error("Task leaked into another user's task list");
    }
    console.log("Cross-user isolation verified (404 on direct access, task absent from other user's list)");

    // 12. Task installation ownership: another user's installationId is rejected
    console.log("\n12. Testing task creation rejects unlinked installations...");
    const instTaskId = "task_inst_guard";
    await repo.createTask(instTaskId, createTaskPayload, "agent/patch-inst", testUserId);
    const foreignInstallRes = await fetch(`${BASE_URL}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({
        repo: { owner: "acme-corp", repo: "payment-service", branch: "main", installationId: 987654 },
        prompt: "test prompt for installation guard",
        model: "codex",
      }),
    });
    if (foreignInstallRes.status !== 400) {
      throw new Error(`Expected 400 for task on unlinked installation, got ${foreignInstallRes.status}`);
    }
    console.log("Task creation correctly rejected unlinked installationId with 400");

    console.log("\nAll control plane and multi-turn follow-up tests passed successfully!");
  } finally {
    server.stop();
  }
}

runTests().catch((err) => {
  console.error("Test failure:", err);
  process.exit(1);
});
