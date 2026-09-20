import { MemoryTaskRepository } from "./db/repository.ts";
import { MemoryEventBus } from "./events/event-bus.ts";
import { TaskWorker } from "./queue/task-worker.ts";
import { DirectTaskQueue } from "./queue/task-queue.ts";
import { createServer } from "./server.ts";
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

    // 2. Save auth session
    console.log("\n2. Testing POST /api/auth/session...");
    const authPayload = {
      provider: "codex",
      authJson: JSON.stringify({ token: "test-oauth-token-subscription", expiresAt: 9999999999 }),
    };
    const authRes = await fetch(`${BASE_URL}/api/auth/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
    const codexCheckRes = await fetch(`${BASE_URL}/api/auth/session/codex`);
    const codexCheck = (await codexCheckRes.json()) as { provider: string; configured: boolean };
    console.log("Codex check:", codexCheck);
    if (!codexCheck.configured) {
      throw new Error("Codex auth should be configured");
    }

    const claudeCheckRes = await fetch(`${BASE_URL}/api/auth/session/claude`);
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
      headers: { "Content-Type": "application/json" },
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
    const getRes = await fetch(`${BASE_URL}/api/tasks/${taskId}`);
    if (!getRes.ok) throw new Error(`Get task failed: ${getRes.status}`);
    const getData = (await getRes.json()) as { task: { id: string; prompt: string } };
    console.log("Retrieved task prompt:", getData.task.prompt);
    if (getData.task.id !== taskId) {
      throw new Error("Mismatch in retrieved task ID");
    }

    // 6. List Tasks
    console.log("\n6. Testing GET /api/tasks...");
    const listRes = await fetch(`${BASE_URL}/api/tasks?limit=10`);
    if (!listRes.ok) throw new Error(`List tasks failed: ${listRes.status}`);
    const listData = (await listRes.json()) as { tasks: Array<{ id: string }> };
    console.log(`Found ${listData.tasks.length} tasks in list`);
    if (!listData.tasks.some((t) => t.id === taskId)) {
      throw new Error("Created task not present in list");
    }

    // 7. Test SSE Stream
    console.log("\n7. Testing GET /api/tasks/:id/stream (SSE)...");
    const streamRes = await fetch(`${BASE_URL}/api/tasks/${taskId}/stream`);
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
    const cancelRes = await fetch(`${BASE_URL}/api/tasks/${taskId}/cancel`, { method: "POST" });
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

    console.log("\nAll Phase 3 control plane tests passed successfully!");
  } finally {
    server.stop();
  }
}

runTests().catch((err) => {
  console.error("Test failure:", err);
  process.exit(1);
});
