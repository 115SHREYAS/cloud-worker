/**
 * Free local mock Anthropic server for testing Claude Code and Claude Agent SDK.
 * Implements the Anthropic Messages API (/v1/messages) streaming protocol with SSE.
 *
 * Usage:
 *   bun scripts/mock-claude-server.ts
 *
 * Then set in your .env or environment:
 *   ANTHROPIC_BASE_URL=http://localhost:8082
 *   ANTHROPIC_AUTH_TOKEN=mock-token
 *   ANTHROPIC_API_KEY=""
 */

const PORT = Number(process.env.MOCK_PORT || 8082);

console.log(`[mock-claude] Starting mock Anthropic inference server on port ${PORT}...`);

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // Health check
    if (url.pathname === "/health" || url.pathname === "/") {
      return Response.json({ status: "ok", provider: "mock-claude-inference" });
    }

    // Anthropic Messages endpoint
    if (url.pathname === "/v1/messages" && req.method === "POST") {
      let body: any = {};
      try {
        body = await req.json();
      } catch {
        // continue
      }

      console.log(`[mock-claude] Received /v1/messages request (model: ${body.model || "default"})`);

      const messages = body.messages || [];
      const lastMessage = messages[messages.length - 1];
      const hasToolResult =
        Array.isArray(lastMessage?.content) &&
        lastMessage.content.some((c: any) => c.type === "tool_result");

      // Build SSE stream response
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          const send = (event: string, data: object) => {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          };

          if (!hasToolResult) {
            // First turn: model thinks and calls the Bash tool
            send("message_start", {
              type: "message_start",
              message: {
                id: `msg_${Date.now()}_1`,
                type: "message",
                role: "assistant",
                model: body.model || "claude-3-7-sonnet-20250219",
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 150, output_tokens: 1 },
              },
            });

            // Thinking block
            send("content_block_start", {
              type: "content_block_start",
              index: 0,
              content_block: { type: "thinking", thinking: "" },
            });
            send("content_block_delta", {
              type: "content_block_delta",
              index: 0,
              delta: {
                type: "thinking_delta",
                thinking: "Inspecting the local workspace and verifying the Claude Agent SDK harness...",
              },
            });
            send("content_block_stop", { type: "content_block_stop", index: 0 });

            // Tool use block (Bash)
            send("content_block_start", {
              type: "content_block_start",
              index: 1,
              content_block: {
                type: "tool_use",
                id: `toolu_${Date.now()}`,
                name: "Bash",
                input: {},
              },
            });
            send("content_block_delta", {
              type: "content_block_delta",
              index: 1,
              delta: {
                type: "input_json_delta",
                partial_json: JSON.stringify({
                  command: "echo 'Claude Agent SDK in-VM execution verified!' && git status --short",
                }),
              },
            });
            send("content_block_stop", { type: "content_block_stop", index: 1 });

            send("message_delta", {
              type: "message_delta",
              delta: { stop_reason: "tool_use", stop_sequence: null },
              usage: { output_tokens: 48 },
            });
            send("message_stop", { type: "message_stop" });
          } else {
            // Second turn: tool result received, final summary output
            send("message_start", {
              type: "message_start",
              message: {
                id: `msg_${Date.now()}_2`,
                type: "message",
                role: "assistant",
                model: body.model || "claude-3-7-sonnet-20250219",
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 220, output_tokens: 1 },
              },
            });

            send("content_block_start", {
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" },
            });
            send("content_block_delta", {
              type: "content_block_delta",
              index: 0,
              delta: {
                type: "text_delta",
                text: "All tests and commands executed successfully through the mock Anthropic inference endpoint. The Claude Agent SDK harness, multi-turn state preservation, and token counting are completely verified.",
              },
            });
            send("content_block_stop", { type: "content_block_stop", index: 0 });

            send("message_delta", {
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: 52 },
            });
            send("message_stop", { type: "message_stop" });
          }

          controller.close();
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`[mock-claude] Ready at http://localhost:${server.port}`);
