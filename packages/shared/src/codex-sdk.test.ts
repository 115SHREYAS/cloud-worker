import { describe, it, expect } from "bun:test";
import {
  parseCodexRunnerLine,
  mapCodexSdkEvent,
  summarizeCodexUsage,
} from "./codex-sdk";
import type { StreamEvent } from "./events";

describe("Codex SDK runner protocol (@cloud-worker/shared)", () => {
  it("parses valid CW1 protocol lines", () => {
    const ready = parseCodexRunnerLine(`CW1 {"t":"ready","sdk":"0.164.0","node":"v22.0.0"}`);
    expect(ready).not.toBeNull();
    expect(ready?.t).toBe("ready");

    const thread = parseCodexRunnerLine(`CW1 {"t":"thread","id":"th_abc123","resumed":false}`);
    expect(thread?.t).toBe("thread");
    if (thread?.t === "thread") {
      expect(thread.id).toBe("th_abc123");
      expect(thread.resumed).toBe(false);
    }

    const result = parseCodexRunnerLine(
      `CW1 {"t":"result","code":0,"final":"Done","usage":{"input_tokens":100,"cached_input_tokens":50,"cache_write_input_tokens":0,"output_tokens":20,"reasoning_output_tokens":8}}`,
    );
    expect(result?.t).toBe("result");
    if (result?.t === "result") {
      expect(result.code).toBe(0);
      expect(result.usage?.input_tokens).toBe(100);
      expect(result.final).toBe("Done");
    }
  });

  it("rejects non-protocol and malformed lines", () => {
    expect(parseCodexRunnerLine("OpenAI Codex v0.164.0")).toBeNull();
    expect(parseCodexRunnerLine("exec")).toBeNull();
    expect(parseCodexRunnerLine("CW1 not-json")).toBeNull();
    expect(parseCodexRunnerLine(`CW1 {"t":"bogus"}`)).toBeNull();
    expect(parseCodexRunnerLine("")).toBeNull();
  });

  it("maps command_execution lifecycle to tool_call and tool_result", () => {
    const started = mapCodexSdkEvent(
      {
        type: "item.started",
        item: {
          id: "cmd_1",
          type: "command_execution",
          command: "npm test",
          aggregated_output: "",
          status: "in_progress",
        },
      },
      "task-1",
    );
    expect(started.length).toBe(1);
    expect(started[0]?.type).toBe("tool_call");
    if (started[0]?.type === "tool_call") {
      expect(started[0].tool).toBe("bash");
      expect(started[0].args.command).toBe("npm test");
    }

    const completed = mapCodexSdkEvent(
      {
        type: "item.completed",
        item: {
          id: "cmd_1",
          type: "command_execution",
          command: "npm test",
          aggregated_output: "3 passing",
          exit_code: 0,
          status: "completed",
        },
      },
      "task-1",
    );
    expect(completed.length).toBe(1);
    expect(completed[0]?.type).toBe("tool_result");
    if (completed[0]?.type === "tool_result") {
      expect(completed[0].callId).toBe("cmd_1");
      expect(completed[0].exitCode).toBe(0);
      expect(completed[0].isError).toBe(false);
    }

    const failed = mapCodexSdkEvent(
      {
        type: "item.completed",
        item: {
          id: "cmd_2",
          type: "command_execution",
          command: "npm test",
          aggregated_output: "1 failing",
          status: "failed",
        },
      },
      "task-1",
    );
    if (failed[0]?.type === "tool_result") {
      expect(failed[0].exitCode).toBe(1);
      expect(failed[0].isError).toBe(true);
    }
  });

  it("maps reasoning and agent_message items", () => {
    const thought = mapCodexSdkEvent(
      { type: "item.completed", item: { id: "r_1", type: "reasoning", text: "Inspecting the failing test" } },
      "task-1",
    );
    expect(thought[0]?.type).toBe("thought");
    if (thought[0]?.type === "thought") {
      expect(thought[0].thought).toBe("Inspecting the failing test");
    }

    // Empty reasoning text emits nothing
    expect(
      mapCodexSdkEvent({ type: "item.completed", item: { id: "r_2", type: "reasoning", text: "  " } }, "task-1"),
    ).toEqual([]);

    const message = mapCodexSdkEvent(
      { type: "item.completed", item: { id: "m_1", type: "agent_message", text: "Fixed the parser bug." } },
      "task-1",
    );
    expect(message[0]?.type).toBe("agent_message");
    if (message[0]?.type === "agent_message") {
      expect(message[0].message).toBe("Fixed the parser bug.");
    }
  });

  it("maps file_change items to per-file write_file tool calls", () => {
    const events: StreamEvent[] = mapCodexSdkEvent(
      {
        type: "item.completed",
        item: {
          id: "fc_1",
          type: "file_change",
          status: "completed",
          changes: [
            { path: "src/parser.ts", kind: "update" },
            { path: "src/new-file.ts", kind: "add" },
          ],
        },
      },
      "task-1",
    );
    expect(events.length).toBe(2);
    expect(events[0]?.type).toBe("tool_call");
    if (events[0]?.type === "tool_call") {
      expect(events[0].tool).toBe("write_file");
      expect(events[0].args.path).toBe("src/parser.ts");
      expect(events[0].args.change).toBe("update");
    }
    if (events[1]?.type === "tool_call") {
      expect(events[1].args.change).toBe("add");
    }
  });

  it("maps turn.completed usage to a usage stream event", () => {
    const events = mapCodexSdkEvent(
      {
        type: "turn.completed",
        usage: {
          input_tokens: 12000,
          cached_input_tokens: 9500,
          cache_write_input_tokens: 0,
          output_tokens: 2300,
          reasoning_output_tokens: 1100,
        },
      },
      "task-1",
    );
    expect(events.length).toBe(1);
    expect(events[0]?.type).toBe("usage");
    if (events[0]?.type === "usage") {
      expect(events[0].inputTokens).toBe(12000);
      expect(events[0].cachedInputTokens).toBe(9500);
      expect(events[0].outputTokens).toBe(2300);
      expect(events[0].totalTokens).toBe(14300);
    }
  });

  it("ignores lifecycle, unknown, and malformed events without throwing", () => {
    expect(mapCodexSdkEvent({ type: "thread.started", thread_id: "th_1" }, "task-1")).toEqual([]);
    expect(mapCodexSdkEvent({ type: "turn.started" }, "task-1")).toEqual([]);
    expect(mapCodexSdkEvent({ type: "item.updated", item: { id: "x", type: "reasoning", text: "partial" } }, "task-1")).toEqual([]);
    expect(mapCodexSdkEvent({ type: "turn.failed", error: { message: "boom" } }, "task-1")).toEqual([]);
    expect(mapCodexSdkEvent({ type: "error", message: "boom" }, "task-1")).toEqual([]);
    expect(mapCodexSdkEvent({ type: "item.completed", item: { type: "mcp_tool_call", server: "s", tool: "t" } }, "task-1")).toEqual([]);
    expect(mapCodexSdkEvent({ type: "item.completed", item: { type: "web_search", query: "q" } }, "task-1")).toEqual([]);
    expect(mapCodexSdkEvent({ type: "item.completed", item: { type: "todo_list", items: [] } }, "task-1")).toEqual([]);
    expect(mapCodexSdkEvent(null, "task-1")).toEqual([]);
    expect(mapCodexSdkEvent("garbage", "task-1")).toEqual([]);
    expect(mapCodexSdkEvent({ type: "turn.completed", usage: { input_tokens: -5, output_tokens: 1 } }, "task-1")).toEqual([]);
  });

  it("summarizes usage with totals", () => {
    const summary = summarizeCodexUsage({
      input_tokens: 10,
      output_tokens: 5,
      cached_input_tokens: 4,
    });
    expect(summary.totalTokens).toBe(15);
    expect(summary.cachedInputTokens).toBe(4);
  });
});
