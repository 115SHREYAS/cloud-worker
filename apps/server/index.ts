import { getTaskChannel, TaskStatusSchema, type TaskStatus } from "@cloud-worker/shared";

const PORT = Number(process.env.PORT) || 3001;

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return Response.json({
        status: "ok",
        service: "cloud-worker-server",
        runtime: "bun",
        supportedStatuses: TaskStatusSchema.options,
        timestamp: Date.now(),
      });
    }

    if (url.pathname.startsWith("/api/tasks/channel/")) {
      const taskId = url.pathname.replace("/api/tasks/channel/", "");
      return Response.json({
        taskId,
        channel: getTaskChannel(taskId),
      });
    }

    return new Response("Cloud Worker Control Plane (Bun)");
  },
});

console.log(`Backend server running at http://localhost:${server.port}`);