"use client";

import { useState } from "react";
import type { StreamEvent } from "@cloud-worker/shared";
import {
  Terminal as TerminalIcon,
  Brain,
  FileCode,
  CheckCircle2,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  GitBranch,
  Server,
  Zap,
} from "lucide-react";

interface AgentTimelineProps {
  events: StreamEvent[];
}

export function AgentTimeline({ events }: AgentTimelineProps) {
  const [expandedCalls, setExpandedCalls] = useState<Record<string, boolean>>({});

  const toggleCall = (callId: string) => {
    setExpandedCalls((prev) => ({
      ...prev,
      [callId]: !prev[callId],
    }));
  };

  // Filter out raw stdout/stderr chunks and pings to focus on structured reasoning
  const timelineEvents = events.filter(
    (e) => e.type !== "stdout" && e.type !== "stderr" && e.type !== "ping",
  );

  if (timelineEvents.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center p-12 text-center text-zinc-500 rounded-xl border border-dashed border-zinc-800 bg-zinc-950/40">
        <Brain className="w-8 h-8 mb-3 text-zinc-600 animate-pulse" />
        <p className="text-sm font-medium text-zinc-400">No agent reasoning steps recorded yet.</p>
        <p className="text-xs text-zinc-600 mt-1">
          Agent thoughts, tool executions, and state changes appear here in real time.
        </p>
      </div>
    );
  }

  return (
    <div className="relative pl-6 space-y-6 before:absolute before:left-2.5 before:top-3 before:bottom-3 before:w-0.5 before:bg-zinc-800">
      {timelineEvents.map((event, idx) => {
        const timeStr = new Date(event.timestamp).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });

        if (event.type === "status") {
          return (
            <div key={`status-${idx}`} className="relative flex items-start gap-4">
              <span className="absolute -left-6 mt-1 flex items-center justify-center w-5 h-5 rounded-full bg-zinc-900 border border-zinc-700 text-zinc-300">
                {event.status === "completed" ? (
                  <CheckCircle2 className="w-3.5 h-3.5 text-blue-400" />
                ) : event.status === "failed" ? (
                  <AlertCircle className="w-3.5 h-3.5 text-rose-400" />
                ) : event.status === "provisioning" ? (
                  <Server className="w-3 h-3 text-cyan-400" />
                ) : event.status === "cloning" ? (
                  <GitBranch className="w-3 h-3 text-amber-400" />
                ) : (
                  <Zap className="w-3 h-3 text-blue-400" />
                )}
              </span>

              <div className="flex-1 bg-zinc-900/60 border border-zinc-800/80 rounded-lg p-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold font-mono uppercase px-2 py-0.5 rounded bg-zinc-800 text-zinc-200">
                      {event.status}
                    </span>
                    <span className="text-xs text-zinc-400">
                      {event.message || `Task entered ${event.status} state`}
                    </span>
                  </div>
                  <span className="text-[11px] font-mono text-zinc-500">{timeStr}</span>
                </div>
              </div>
            </div>
          );
        }

        if (event.type === "thought") {
          return (
            <div key={`thought-${idx}`} className="relative flex items-start gap-4">
              <span className="absolute -left-6 mt-1 flex items-center justify-center w-5 h-5 rounded-full bg-purple-950/80 border border-purple-800 text-purple-400">
                <Brain className="w-3 h-3" />
              </span>

              <div className="flex-1 bg-purple-950/20 border border-purple-900/40 rounded-lg p-3.5">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-semibold text-purple-400 flex items-center gap-1.5">
                    Agent reasoning
                  </span>
                  <span className="text-[11px] font-mono text-zinc-500">{timeStr}</span>
                </div>
                <p className="text-xs text-zinc-300 leading-relaxed whitespace-pre-wrap font-sans">
                  {event.thought}
                </p>
              </div>
            </div>
          );
        }

        if (event.type === "tool_call") {
          const isExpanded = expandedCalls[event.callId] ?? false;
          return (
            <div key={`call-${event.callId}-${idx}`} className="relative flex items-start gap-4">
              <span className="absolute -left-6 mt-1 flex items-center justify-center w-5 h-5 rounded-full bg-zinc-900 border border-zinc-700 text-zinc-400">
                <TerminalIcon className="w-3 h-3" />
              </span>

              <div className="flex-1 bg-zinc-900/70 border border-zinc-800 rounded-lg overflow-hidden">
                <button
                  type="button"
                  onClick={() => toggleCall(event.callId)}
                  className="w-full flex items-center justify-between p-3 hover:bg-zinc-800/40 transition-colors text-left cursor-pointer"
                >
                  <div className="flex items-center gap-2">
                    {isExpanded ? (
                      <ChevronDown className="w-3.5 h-3.5 text-zinc-400" />
                    ) : (
                      <ChevronRight className="w-3.5 h-3.5 text-zinc-400" />
                    )}
                    <span className="text-xs font-mono font-semibold text-blue-400">
                      {event.tool}
                    </span>
                    <span className="text-[11px] text-zinc-400 font-mono truncate max-w-sm">
                      {JSON.stringify(event.args)}
                    </span>
                  </div>
                  <span className="text-[11px] font-mono text-zinc-500">{timeStr}</span>
                </button>

                {isExpanded && (
                  <div className="p-3 border-t border-zinc-800/60 bg-zinc-950/60 font-mono text-xs">
                    <div className="text-zinc-500 mb-1 text-[11px]">Arguments:</div>
                    <pre className="p-2 rounded bg-zinc-900 text-zinc-300 overflow-x-auto">
                      {JSON.stringify(event.args, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            </div>
          );
        }

        if (event.type === "tool_result") {
          return (
            <div key={`result-${event.callId}-${idx}`} className="relative flex items-start gap-4">
              <span className="absolute -left-6 mt-1 flex items-center justify-center w-5 h-5 rounded-full bg-zinc-900 border border-zinc-700 text-zinc-400">
                <CheckCircle2 className="w-3 h-3 text-blue-400" />
              </span>

              <div className="flex-1 bg-zinc-900/40 border border-zinc-800/60 rounded-lg p-3 font-mono text-xs">
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-zinc-400 font-semibold uppercase">
                      Output ({event.tool})
                    </span>
                    {event.exitCode !== undefined && (
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${
                          event.exitCode === 0
                            ? "bg-blue-950 text-blue-400"
                            : "bg-rose-950 text-rose-400"
                        }`}
                      >
                        exit: {event.exitCode}
                      </span>
                    )}
                  </div>
                  <span className="text-[11px] text-zinc-500">{timeStr}</span>
                </div>
                <pre className="p-2 rounded bg-zinc-950 text-zinc-300 max-h-48 overflow-y-auto whitespace-pre-wrap">
                  {event.output || "(no output)"}
                </pre>
              </div>
            </div>
          );
        }

        if (event.type === "diff") {
          return (
            <div key={`diff-${idx}`} className="relative flex items-start gap-4">
              <span className="absolute -left-6 mt-1 flex items-center justify-center w-5 h-5 rounded-full bg-blue-950/80 border border-blue-800 text-blue-400">
                <FileCode className="w-3 h-3" />
              </span>

              <div className="flex-1 bg-blue-950/20 border border-blue-900/40 rounded-lg p-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-semibold text-blue-400">Git diff updated</span>
                  <span className="text-[11px] font-mono text-zinc-500">{timeStr}</span>
                </div>
                <p className="text-xs text-zinc-400">
                  New working changes committed by agent harness.
                </p>
              </div>
            </div>
          );
        }

        if (event.type === "done") {
          return (
            <div key={`done-${idx}`} className="relative flex items-start gap-4">
              <span className="absolute -left-6 mt-1 flex items-center justify-center w-5 h-5 rounded-full bg-blue-950 border border-blue-700 text-blue-400">
                <CheckCircle2 className="w-3.5 h-3.5" />
              </span>

              <div className="flex-1 bg-blue-950/20 border border-blue-900/40 rounded-lg p-3.5">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-semibold text-blue-400">Execution complete</span>
                  <span className="text-[11px] font-mono text-zinc-500">{timeStr}</span>
                </div>
                <p className="text-xs text-zinc-300">
                  {event.summary || "Task completed successfully"}
                </p>
                {event.pullRequestUrl && (
                  <a
                    href={event.pullRequestUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-block mt-2 text-xs text-blue-400 underline font-mono hover:text-blue-300"
                  >
                    View Pull Request
                  </a>
                )}
              </div>
            </div>
          );
        }

        if (event.type === "error") {
          return (
            <div key={`err-${idx}`} className="relative flex items-start gap-4">
              <span className="absolute -left-6 mt-1 flex items-center justify-center w-5 h-5 rounded-full bg-rose-950 border border-rose-700 text-rose-400">
                <AlertCircle className="w-3.5 h-3.5" />
              </span>

              <div className="flex-1 bg-rose-950/20 border border-rose-900/40 rounded-lg p-3.5">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-semibold text-rose-400">Task failed</span>
                  <span className="text-[11px] font-mono text-zinc-500">{timeStr}</span>
                </div>
                <p className="text-xs text-rose-200/90 font-mono whitespace-pre-wrap">
                  {event.message}
                </p>
              </div>
            </div>
          );
        }

        return null;
      })}
    </div>
  );
}
