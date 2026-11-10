import { describe, it, expect } from "bun:test";
import {
  parseClaudeRunnerLine,
  mapClaudeSdkEvent,
  summarizeClaudeUsage,
  mapClaudeToolName,
} from "./claude-sdk";

describe("Claude Agent SDK runner protocol (@cloud-worker/shared)", () => {
  it("parses valid CW1 protocol lines", () => {
    const ready = parseClaudeRunnerLine(`CW1 {"t":"ready","sdk":"0.3.319","node":"v22.0.0"}`);
    expect(ready).not.toBeNull();
    expect(ready?.t).toBe("ready");

    const session = parseClaudeRunnerLine(`CW1 {"t":"session","id":"sess_claude_123","resumed":true}`);
    expect(session?.t).toBe("session");
    if (session?.t === "session") {
      expect(session.id).toBe("sess_claude_123");
      expect(session.resumed).toBe(true);
    }

    const result = parseClaudeRunnerLine(
      `CW1 {"t":"result","code":0,"final":"All tests passing!","usage":{"input_tokens":1500,"output_tokens":320,"cache_read_input_tokens":1200,"cache_creation_input_tokens":100},"totalCostUsd":0.015}`,
    );
    expect(result?.t).toBe("result");
    if (result?.t === "result") {
      expect(result.code).toBe(0);
      expect(result.final).toBe("All tests passing!");
      expect(result.usage?.input_tokens).toBe(1500);
      expect(result.totalCostUsd).toBe(0.015);
    }
  });

  it("rejects non-protocol and malformed lines", () => {
    expect(parseClaudeRunnerLine("Claude Code v2.1.319")).toBeNull();
    expect(parseClaudeRunnerLine("CW1 not-json")).toBeNull();
    expect(parseClaudeRunnerLine(`CW1 {"t":"unknown_type"}`)).toBeNull();
    expect(parseClaudeRunnerLine("")).toBeNull();
  });

  it("normalizes Claude SDK tool names to canonical AgentToolNames", () => {
    expect(mapClaudeToolName("Bash")).toBe("bash");
    expect(mapClaudeToolName("bash")).toBe("bash");
    expect(mapClaudeToolName("Read")).toBe("read_file");
    expect(mapClaudeToolName("View")).toBe("read_file");
    expect(mapClaudeToolName("Write")).toBe("write_file");
    expect(mapClaudeToolName("Edit")).toBe("write_file");
    expect(mapClaudeToolName("MultiEdit")).toBe("write_file");
    expect(mapClaudeToolName("Glob")).toBe("list_dir");
    expect(mapClaudeToolName("GitDiff")).toBe("git_diff");
    expect(mapClaudeToolName("UnknownCustomTool")).toBeNull();
  });

  it("maps assistant thinking blocks to thought events", () => {
    const events = mapClaudeSdkEvent(
      {
        type: "assistant",
        session_id: "sess_1",
        message: {
          content: [
            {
              type: "thinking",
              thinking: "I should inspect package.json to find test scripts.",
            },
          ],
        },
      },
      "task-claude-1",
    );

    expect(events.length).toBe(1);
    expect(events[0]?.type).toBe("thought");
    if (events[0]?.type === "thought") {
      expect(events[0].thought).toBe("I should inspect package.json to find test scripts.");
      expect(events[0].taskId).toBe("task-claude-1");
    }
  });

  it("maps assistant tool_use blocks to tool_call events", () => {
    const events = mapClaudeSdkEvent(
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "call_bash_123",
              name: "Bash",
              input: { command: "bun test" },
            },
            {
              type: "tool_use",
              id: "call_read_456",
              name: "Read",
              input: { file_path: "src/index.ts" },
            },
            {
              type: "tool_use",
              id: "call_edit_789",
              name: "Edit",
              input: { file_path: "src/index.ts", content: "console.log('hi')" },
            },
          ],
        },
      },
      "task-claude-1",
    );

    expect(events.length).toBe(3);
    expect(events[0]?.type).toBe("tool_call");
    if (events[0]?.type === "tool_call") {
      expect(events[0].tool).toBe("bash");
      expect(events[0].callId).toBe("call_bash_123");
      expect(events[0].args.command).toBe("bun test");
    }

    expect(events[1]?.type).toBe("tool_call");
    if (events[1]?.type === "tool_call") {
      expect(events[1].tool).toBe("read_file");
      expect(events[1].args.path).toBe("src/index.ts");
    }

    expect(events[2]?.type).toBe("tool_call");
    if (events[2]?.type === "tool_call") {
      expect(events[2].tool).toBe("write_file");
      expect(events[2].args.path).toBe("src/index.ts");
    }
  });

  it("maps user message tool_results to tool_result events", () => {
    const events = mapClaudeSdkEvent(
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_bash_123",
              content: "Tests passed: 10/10",
              is_error: false,
            },
            {
              type: "tool_result",
              tool_use_id: "call_read_failed",
              content: "File not found",
              is_error: true,
            },
          ],
        },
      },
      "task-claude-1",
    );

    expect(events.length).toBe(2);
    expect(events[0]?.type).toBe("tool_result");
    if (events[0]?.type === "tool_result") {
      expect(events[0].callId).toBe("call_bash_123");
      expect(events[0].output).toBe("Tests passed: 10/10");
      expect(events[0].isError).toBe(false);
      expect(events[0].exitCode).toBe(0);
    }

    expect(events[1]?.type).toBe("tool_result");
    if (events[1]?.type === "tool_result") {
      expect(events[1].callId).toBe("call_read_failed");
      expect(events[1].output).toBe("File not found");
      expect(events[1].isError).toBe(true);
      expect(events[1].exitCode).toBe(1);
    }
  });

  it("maps assistant text blocks to agent_message events", () => {
    const events = mapClaudeSdkEvent(
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "text",
              text: "I have resolved the bug by updating the error handler.",
            },
          ],
        },
      },
      "task-claude-1",
    );

    expect(events.length).toBe(1);
    expect(events[0]?.type).toBe("agent_message");
    if (events[0]?.type === "agent_message") {
      expect(events[0].message).toContain("I have resolved the bug");
    }
  });

  it("maps result message to usage event and agent_message summary", () => {
    const events = mapClaudeSdkEvent(
      {
        type: "result",
        subtype: "success",
        total_cost_usd: 0.042,
        modelUsage: {
          "claude-3-7-sonnet-20250219": {
            inputTokens: 10000,
            outputTokens: 1500,
            cacheReadInputTokens: 7500,
            cacheCreationInputTokens: 500,
          },
        },
        result: "Task finished successfully.",
      },
      "task-claude-1",
    );

    expect(events.length).toBe(2);
    const usageEv = events.find((e) => e.type === "usage");
    expect(usageEv).toBeDefined();
    if (usageEv && usageEv.type === "usage") {
      expect(usageEv.inputTokens).toBe(10000);
      expect(usageEv.outputTokens).toBe(1500);
      expect(usageEv.cachedInputTokens).toBe(8000);
      expect(usageEv.totalTokens).toBe(11500);
      expect(usageEv.model).toBe("claude-3-7-sonnet-20250219");
    }

    const msgEv = events.find((e) => e.type === "agent_message");
    expect(msgEv).toBeDefined();
    if (msgEv && msgEv.type === "agent_message") {
      expect(msgEv.message).toBe("Task finished successfully.");
    }
  });

  it("summarizes usage correctly from snake_case and camelCase forms", () => {
    const snake = summarizeClaudeUsage(
      {
        input_tokens: 500,
        output_tokens: 100,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 50,
      },
      0.005,
    );
    expect(snake.inputTokens).toBe(500);
    expect(snake.outputTokens).toBe(100);
    expect(snake.cachedInputTokens).toBe(250);
    expect(snake.totalTokens).toBe(600);
    expect(snake.estimatedCostUsd).toBe(0.005);

    const camel = summarizeClaudeUsage(
      {
        inputTokens: 800,
        outputTokens: 200,
        cacheReadInputTokens: 300,
        cacheCreationInputTokens: 100,
      },
      0.008,
    );
    expect(camel.inputTokens).toBe(800);
    expect(camel.outputTokens).toBe(200);
    expect(camel.cachedInputTokens).toBe(400);
    expect(camel.totalTokens).toBe(1000);
  });
});
