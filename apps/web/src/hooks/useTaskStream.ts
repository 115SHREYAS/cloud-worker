"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import type { StreamEvent, TaskStatus } from "@cloud-worker/shared";
import { StreamEventSchema } from "@cloud-worker/shared";
import { cancelTask as apiCancelTask } from "../lib/api";

export interface ToolCallItem {
  callId: string;
  tool: string;
  args: Record<string, unknown>;
  output?: string;
  exitCode?: number;
  isError?: boolean;
  timestamp: number;
}

export interface TaskStreamState {
  status: TaskStatus;
  events: StreamEvent[];
  terminalBuffer: string;
  thoughts: Array<{ thought: string; timestamp: number }>;
  toolCalls: ToolCallItem[];
  diff: string;
  pullRequestUrl: string | null;
  error: string | null;
  isConnected: boolean;
  isFinished: boolean;
  cancel: () => Promise<void>;
  clearTerminal: () => void;
}

export function useTaskStream(
  taskId: string | null,
  options?: {
    initialStatus?: TaskStatus;
    onChunk?: (data: string) => void;
  },
): TaskStreamState {
  const [status, setStatus] = useState<TaskStatus>(options?.initialStatus || "pending");
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [terminalBuffer, setTerminalBuffer] = useState<string>("");
  const [thoughts, setThoughts] = useState<Array<{ thought: string; timestamp: number }>>([]);
  const [toolCalls, setToolCalls] = useState<ToolCallItem[]>([]);
  const [diff, setDiff] = useState<string>("");
  const [pullRequestUrl, setPullRequestUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState<boolean>(false);

  const onChunkRef = useRef(options?.onChunk);
  useEffect(() => {
    onChunkRef.current = options?.onChunk;
  }, [options?.onChunk]);

  const clearTerminal = useCallback(() => {
    setTerminalBuffer("");
  }, []);

  const cancel = useCallback(async () => {
    if (!taskId) return;
    try {
      await apiCancelTask(taskId);
      setStatus("cancelled");
    } catch (err) {
      console.error("Failed to cancel task:", err);
    }
  }, [taskId]);

  useEffect(() => {
    if (!taskId) return;

    const API_BASE = process.env.NEXT_PUBLIC_API_URL || "";
    const streamUrl = `${API_BASE}/api/tasks/${taskId}/stream`;
    const eventSource = new EventSource(streamUrl);

    eventSource.onopen = () => {
      setIsConnected(true);
      setError(null);
    };

    eventSource.onmessage = (messageEvent) => {
      try {
        const raw = JSON.parse(messageEvent.data);
        const parsed = StreamEventSchema.safeParse(raw);
        if (!parsed.success) return;

        const event = parsed.data;

        // Skip keepalive pings
        if (event.type === "ping") return;

        // Only store structured events in the events array to prevent unbounded memory growth
        if (event.type !== "stdout" && event.type !== "stderr") {
          setEvents((prev) => [...prev, event]);
        }

        switch (event.type) {
          case "stdout":
          case "stderr": {
            setTerminalBuffer((prev) => prev + event.data);
            if (onChunkRef.current) {
              onChunkRef.current(event.data);
            }
            break;
          }
          case "thought": {
            setThoughts((prev) => [
              ...prev,
              { thought: event.thought, timestamp: event.timestamp },
            ]);
            break;
          }
          case "tool_call": {
            setToolCalls((prev) => [
              ...prev,
              {
                callId: event.callId,
                tool: event.tool,
                args: event.args,
                timestamp: event.timestamp,
              },
            ]);
            break;
          }
          case "tool_result": {
            setToolCalls((prev) =>
              prev.map((item) =>
                item.callId === event.callId
                  ? {
                      ...item,
                      output: event.output,
                      exitCode: event.exitCode,
                      isError: event.isError,
                    }
                  : item,
              ),
            );
            break;
          }
          case "diff": {
            setDiff(event.diff);
            break;
          }
          case "status": {
            setStatus(event.status);
            if (
              event.status === "completed" ||
              event.status === "failed" ||
              event.status === "cancelled"
            ) {
              eventSource.close();
              setIsConnected(false);
            }
            break;
          }
          case "done": {
            setStatus("completed");
            if (event.pullRequestUrl) {
              setPullRequestUrl(event.pullRequestUrl);
            }
            eventSource.close();
            setIsConnected(false);
            break;
          }
          case "error": {
            setError(event.message);
            setStatus("failed");
            eventSource.close();
            setIsConnected(false);
            break;
          }
        }
      } catch (err) {
        console.error("Error parsing SSE stream message:", err);
      }
    };

    eventSource.onerror = () => {
      setIsConnected(false);
    };

    return () => {
      eventSource.close();
      setIsConnected(false);
    };
  }, [taskId]);

  const isFinished =
    status === "completed" || status === "failed" || status === "cancelled";

  return {
    status,
    events,
    terminalBuffer,
    thoughts,
    toolCalls,
    diff,
    pullRequestUrl,
    error,
    isConnected,
    isFinished,
    cancel,
    clearTerminal,
  };
}
