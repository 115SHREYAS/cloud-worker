import { describe, it, expect } from "bun:test";
import { dedupeReplayOverlap } from "./events/replay.ts";
import type { StreamEvent } from "@cloud-worker/shared";

function toolCallEvent(callId: string, timestamp: number): StreamEvent {
  return {
    type: "tool_call",
    taskId: "task-1",
    callId,
    tool: "bash",
    args: { command: "npm test" },
    timestamp,
  };
}

describe("SSE replay overlap dedup", () => {
  it("drops buffered events that the log snapshot already captured", () => {
    const logs: StreamEvent[] = [
      { type: "turn_start", taskId: "task-1", turn: 1, prompt: "fix bug", timestamp: 100 },
      toolCallEvent("item_6:0", 200),
    ];
    // The same event arrived on the bus while logs were being fetched
    const buffered: StreamEvent[] = [toolCallEvent("item_6:0", 200)];

    const result = dedupeReplayOverlap(logs, buffered);
    expect(result.length).toBe(0);
  });

  it("keeps buffered events that are not in the log snapshot", () => {
    const logs: StreamEvent[] = [
      { type: "turn_start", taskId: "task-1", turn: 1, prompt: "fix bug", timestamp: 100 },
    ];
    const buffered: StreamEvent[] = [
      toolCallEvent("item_7:0", 300),
      {
        type: "agent_message",
        taskId: "task-1",
        message: "All done.",
        timestamp: 400,
      },
    ];

    const result = dedupeReplayOverlap(logs, buffered);
    expect(result.length).toBe(2);
    expect(result[0]?.type).toBe("tool_call");
    expect(result[1]?.type).toBe("agent_message");
  });

  it("collapses duplicates within the buffer itself", () => {
    const logs: StreamEvent[] = [];
    const buffered: StreamEvent[] = [
      toolCallEvent("item_6:0", 200),
      toolCallEvent("item_6:0", 200),
    ];

    const result = dedupeReplayOverlap(logs, buffered);
    expect(result.length).toBe(1);
  });

  it("keeps genuinely repeated commands that differ only in timestamp", () => {
    const logs: StreamEvent[] = [];
    const buffered: StreamEvent[] = [
      {
        type: "stdout",
        taskId: "task-1",
        data: "y",
        timestamp: 1000,
      },
      {
        type: "stdout",
        taskId: "task-1",
        data: "y",
        timestamp: 1001,
      },
    ];

    const result = dedupeReplayOverlap(logs, buffered);
    expect(result.length).toBe(2);
  });

  it("returns an empty buffer unchanged", () => {
    expect(dedupeReplayOverlap([toolCallEvent("a", 1)], [])).toEqual([]);
  });
});
