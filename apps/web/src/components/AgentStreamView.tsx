"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import type { Task, TaskStatus, StreamEvent } from "@cloud-worker/shared";
import {
  Brain,
  Terminal,
  FileCode,
  FileText,
  FileEdit,
  Search,
  CheckCircle2,
  AlertCircle,
  Sparkles,
  ChevronDown,
  ChevronRight,
  Copy,
  Check,
  ArrowDown,
  Loader2,
  ExternalLink,
  GitBranch,
  Flame,
  Bot,
  Zap,
} from "lucide-react";

export interface AgentStreamViewProps {
  taskId: string;
  task: Task;
  status: TaskStatus;
  currentTurn: number;
  events: StreamEvent[];
  terminalBuffer: string;
  diff?: string;
  pullRequestUrl?: string | null;
  onSwitchTab?: (tab: "terminal" | "diff") => void;
}

export type StreamItemType =
  | "thought"
  | "command"
  | "file_edit"
  | "file_read"
  | "search"
  | "message"
  | "status_step"
  | "diff_update"
  | "completed"
  | "error";

export interface StreamItem {
  id: string;
  type: StreamItemType;
  title?: string;
  content?: string;
  command?: string;
  filePath?: string;
  query?: string;
  output?: string;
  exitCode?: number;
  isError?: boolean;
  status?: "running" | "completed" | "failed";
  changeKind?: "add" | "update" | "delete";
  timestamp: number;
  turn: number;
}

export interface TurnGroup {
  turn: number;
  prompt: string;
  items: StreamItem[];
}

function stripAnsi(text: string): string {
  return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function cleanCommandOutput(output: string): string {
  if (!output) return "";
  const lines = output.split("\n");
  const filtered = lines.filter((line) => {
    const t = line.trim();
    if (t.startsWith("find: ‘../") || t.startsWith("find: '../")) return false;
    if (
      t.includes("Permission denied") &&
      (t.includes("/run/") || t.includes("/proc/") || t.includes("/sys/"))
    ) {
      return false;
    }
    return true;
  });
  return filtered.join("\n").trim();
}

/**
 * Parses events and raw terminal buffer into desktop-like stream items:
 * thoughts, commands, and assistant output texts.
 */
function useProcessedStreamItems({
  events,
  terminalBuffer,
  task,
  currentTurn,
}: {
  events: StreamEvent[];
  terminalBuffer: string;
  task: Task;
  currentTurn: number;
}): TurnGroup[] {
  return useMemo(() => {
    const turnGroups: Map<number, TurnGroup> = new Map();

    const getOrCreateTurn = (turnNum: number, promptText?: string): TurnGroup => {
      const existing = turnGroups.get(turnNum);
      if (existing) {
        if (promptText && !existing.prompt) {
          existing.prompt = promptText;
        }
        return existing;
      }
      const initialPrompt =
        turnNum === 1 ? task.prompt : promptText || `Turn ${turnNum} follow-up`;
      const group: TurnGroup = {
        turn: turnNum,
        prompt: initialPrompt,
        items: [],
      };
      turnGroups.set(turnNum, group);
      return group;
    };

    // Ensure Turn 1 exists
    getOrCreateTurn(1, task.prompt);

    // 1. Process first-class StreamEvents
    let activeTurn = 1;
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      if (!event) continue;

      if (event.type === "turn_start") {
        activeTurn = event.turn;
        getOrCreateTurn(event.turn, event.prompt);
        continue;
      }

      const turnGroup = getOrCreateTurn(activeTurn);

      if (event.type === "thought") {
        turnGroup.items.push({
          id: `evt-thought-${i}`,
          type: "thought",
          content: event.thought,
          timestamp: event.timestamp,
          turn: activeTurn,
        });
      } else if (event.type === "agent_message") {
        turnGroup.items.push({
          id: `evt-msg-${i}`,
          type: "message",
          content: event.message,
          timestamp: event.timestamp,
          turn: activeTurn,
        });
      } else if (event.type === "tool_call") {
        const isBash = event.tool === "bash";
        const isEdit = event.tool === "write_file";
        const isRead = event.tool === "read_file";
        const isSearch = event.tool === "list_dir";

        const cmd =
          (event.args.command as string) ||
          (event.args.cmd as string) ||
          JSON.stringify(event.args);
        const path =
          (event.args.targetFile as string) ||
          (event.args.path as string) ||
          (event.args.filePath as string) ||
          "";
        const q = (event.args.query as string) || (event.args.regex as string) || "";
        const rawChange = event.args.change as string | undefined;
        const changeKind =
          rawChange === "add" || rawChange === "update" || rawChange === "delete"
            ? rawChange
            : undefined;

        turnGroup.items.push({
          id: event.callId || `evt-tool-${i}`,
          type: isBash
            ? "command"
            : isEdit
            ? "file_edit"
            : isRead
            ? "file_read"
            : isSearch
            ? "search"
            : "command",
          command: cmd,
          filePath: path,
          query: q,
          changeKind,
          status: "running",
          timestamp: event.timestamp,
          turn: activeTurn,
        });
      } else if (event.type === "tool_result") {
        const target = turnGroup.items.find((it) => it.id === event.callId);
        if (target) {
          target.output = cleanCommandOutput(event.output || "");
          target.exitCode = event.exitCode;
          target.isError = event.isError;
          target.status =
            event.isError || (event.exitCode !== undefined && event.exitCode !== 0)
              ? "failed"
              : "completed";
        }
      } else if (event.type === "diff") {
        turnGroup.items.push({
          id: `evt-diff-${i}`,
          type: "diff_update",
          content: event.diff,
          timestamp: event.timestamp,
          turn: activeTurn,
        });
      } else if (event.type === "status") {
        if (event.message && !event.message.includes("entering")) {
          turnGroup.items.push({
            id: `evt-status-${i}`,
            type: "status_step",
            title: event.message,
            timestamp: event.timestamp,
            turn: activeTurn,
          });
        }
      } else if (event.type === "done") {
        turnGroup.items.push({
          id: `evt-done-${i}`,
          type: "completed",
          content: event.summary,
          timestamp: event.timestamp,
          turn: activeTurn,
        });
      } else if (event.type === "error") {
        turnGroup.items.push({
          id: `evt-err-${i}`,
          type: "error",
          content: event.message,
          timestamp: event.timestamp,
          turn: activeTurn,
        });
      }
    }

    // 2. If no first-class thought/tool events exist, extract high-level structure from terminalBuffer
    const hasStructuredEvents = Array.from(turnGroups.values()).some((g) =>
      g.items.some(
        (it) => it.type === "thought" || it.type === "command" || it.type === "file_edit",
      ),
    );

    if (!hasStructuredEvents && terminalBuffer) {
      const cleanText = stripAnsi(terminalBuffer);
      const lines = cleanText.split("\n");
      const turnGroup = getOrCreateTurn(currentTurn || 1);
      const baseTimestamp =
        events.length > 0
          ? events[events.length - 1]?.timestamp || 0
          : task.createdAt
          ? new Date(task.createdAt).getTime()
          : 0;

      let currentThought: string[] = [];
      let currentNarrative: string[] = [];
      let currentCmd: {
        cmd: string;
        outputLines: string[];
        status: "completed" | "failed";
        exitCode: number;
      } | null = null;

      const flushThought = () => {
        if (currentThought.length > 0) {
          const text = currentThought.join("\n").trim();
          if (text) {
            turnGroup.items.push({
              id: `buf-thought-${turnGroup.items.length}`,
              type: "thought",
              content: text,
              timestamp: baseTimestamp,
              turn: currentTurn || 1,
            });
          }
          currentThought = [];
        }
      };

      const flushNarrative = (isFinal = false) => {
        if (currentNarrative.length > 0) {
          let text = currentNarrative.join("\n").trim();
          currentNarrative = [];

          // Clean commit title & prompt artifacts
          text = text
            .replace(/Wrote the commit title to `?\/tmp\/\.pr_title`?:?\s*`?[^`\n]+`?/g, "")
            .trim();
          text = text.replace(/^Commit title:\s*.+$/gm, "").trim();
          text = text.replace(/^\?\?\s+.*$/gm, "").trim();

          if (!text) return;

          // Filter out prompt echoes or startup noise
          if (
            text === task.prompt ||
            text.startsWith("Reading additional input") ||
            text.startsWith("OpenAI Codex v") ||
            text.startsWith("Workflow note:") ||
            text.startsWith("tokens used")
          ) {
            return;
          }

          // Deduplicate identical or substring messages
          const last = turnGroup.items[turnGroup.items.length - 1];
          if (
            last &&
            (last.content === text || (last.content && last.content.includes(text)))
          ) {
            return;
          }

          // Classify intermediate planning as thoughts and final reporting as message
          const isReasoning =
            !isFinal &&
            (text.match(
              /^(I’ll|I'll|I will|I am|I’m|I found|The repository appears|This checkout contains|Thinking)/i,
            ) ||
              text.length < 300);

          if (isReasoning && !isFinal) {
            turnGroup.items.push({
              id: `buf-thought-${turnGroup.items.length}`,
              type: "thought",
              content: text,
              timestamp: baseTimestamp,
              turn: currentTurn || 1,
            });
          } else {
            turnGroup.items.push({
              id: `buf-msg-${turnGroup.items.length}`,
              type: "message",
              content: text,
              timestamp: baseTimestamp,
              turn: currentTurn || 1,
            });
          }
        }
      };

      const flushCmd = () => {
        if (currentCmd) {
          const cleaned = cleanCommandOutput(currentCmd.outputLines.join("\n"));
          if (currentCmd.cmd.includes("/tmp/.pr_title")) {
            currentCmd = null;
            return;
          }
          turnGroup.items.push({
            id: `buf-cmd-${turnGroup.items.length}`,
            type: "command",
            command: currentCmd.cmd,
            output: cleaned || undefined,
            status: currentCmd.status,
            exitCode: currentCmd.exitCode,
            timestamp: baseTimestamp,
            turn: currentTurn || 1,
          });
          currentCmd = null;
        }
      };

      for (let i = 0; i < lines.length; i++) {
        const rawLine = lines[i] ?? "";
        const line = rawLine.trim();

        // Skip harness banners & startup boilerplate
        if (
          line.startsWith("Reading additional input") ||
          line.startsWith("OpenAI Codex v") ||
          line.startsWith("workdir:") ||
          line.startsWith("model:") ||
          line.startsWith("provider:") ||
          line.startsWith("approval:") ||
          line.startsWith("sandbox:") ||
          line.startsWith("reasoning effort:") ||
          line.startsWith("reasoning summaries:") ||
          line.startsWith("session id:") ||
          line === "--------" ||
          line.includes("Cloud Worker MicroVM Session") ||
          line.includes("┌──") ||
          line.includes("└──")
        ) {
          continue;
        }

        if (line === "user" || line.startsWith("Workflow note:") || line === "---") {
          continue;
        }

        if (
          line === "tokens used" ||
          (line.match(/^\d{1,3}(,\d{3})*$/) && lines[i - 1]?.trim() === "tokens used")
        ) {
          continue;
        }

        // 1. Codex CLI "exec" marker
        if (line === "exec") {
          flushThought();
          flushNarrative(false);
          flushCmd();
          i++;
          const cmdLine = lines[i]?.trim() || "";
          let cmdClean = cmdLine;
          const matchIn = cmdLine.match(/^(.*?)\s+in\s+\/workspace$/);
          if (matchIn && matchIn[1]) cmdClean = matchIn[1];
          const matchBash = cmdClean.match(/^\/bin\/bash -lc ["'](.*)["']$/);
          if (matchBash && matchBash[1]) cmdClean = matchBash[1];

          currentCmd = {
            cmd: cmdClean,
            outputLines: [],
            status: "completed",
            exitCode: 0,
          };
          continue;
        }

        // Exit status for Codex command
        if (currentCmd && line.match(/^(exited \d+|succeeded) in \d+ms:/)) {
          const exitMatch = line.match(/^exited (\d+)/);
          if (exitMatch && exitMatch[1]) {
            currentCmd.exitCode = parseInt(exitMatch[1], 10);
            if (currentCmd.exitCode !== 0) currentCmd.status = "failed";
          }
          continue;
        }

        // 2. Codex CLI "codex" marker
        if (line === "codex") {
          flushCmd();
          flushNarrative(false);
          flushThought();
          continue;
        }

        // 3. Claude Code action marker (⏺)
        if (line.startsWith("⏺") || line.startsWith("•")) {
          flushThought();
          flushNarrative(false);
          flushCmd();

          const action = line.replace(/^[⏺•]\s*/, "").trim();
          if (action.match(/^bash:\s*/i)) {
            currentCmd = {
              cmd: action.replace(/^bash:\s*/i, "").trim(),
              outputLines: [],
              status: "completed",
              exitCode: 0,
            };
            continue;
          }
          if (action.match(/^(read file|reading):\s*/i)) {
            turnGroup.items.push({
              id: `buf-read-${turnGroup.items.length}`,
              type: "file_read",
              filePath: action.replace(/^(read file|reading):\s*/i, "").trim(),
              timestamp: baseTimestamp,
              turn: currentTurn || 1,
            });
            continue;
          }
          if (action.match(/^(edit file|edit|write file):\s*/i)) {
            turnGroup.items.push({
              id: `buf-edit-${turnGroup.items.length}`,
              type: "file_edit",
              filePath: action.replace(/^(edit file|edit|write file):\s*/i, "").trim(),
              timestamp: baseTimestamp,
              turn: currentTurn || 1,
            });
            continue;
          }
        }

        // Accumulate command output
        if (currentCmd) {
          if (line === "codex" || line.startsWith("⏺") || line === "exec") {
            flushCmd();
            i--;
          } else {
            currentCmd.outputLines.push(rawLine);
          }
          continue;
        }

        // Thinking trigger
        if (
          line.toLowerCase() === "thinking..." ||
          line.toLowerCase().startsWith("thinking:") ||
          line.toLowerCase().startsWith("thought:")
        ) {
          flushCmd();
          flushNarrative(false);
          const initial = line.replace(/^(thinking(\.\.\.|:)?|thought:)\s*/i, "").trim();
          if (initial) currentThought.push(initial);
          continue;
        }

        // Assistant narrative / explanation
        if (line.length > 0) {
          currentNarrative.push(rawLine);
        } else {
          flushNarrative(false);
        }
      }

      flushCmd();
      flushThought();
      flushNarrative(true);
    }

    return Array.from(turnGroups.values()).sort((a, b) => a.turn - b.turn);
  }, [events, terminalBuffer, task, currentTurn]);
}

/**
 * Clean markdown renderer for thoughts and narrative messages
 */
function MarkdownBlock({ text }: { text: string }) {
  const paragraphs = text.split(/\n\n+/);

  return (
    <div className="space-y-3 text-xs sm:text-sm text-zinc-200 leading-relaxed font-sans select-text">
      {paragraphs.map((p, idx) => {
        const trimmed = p.trim();
        if (!trimmed) return null;

        // Fenced code block
        if (trimmed.startsWith("```")) {
          const lines = trimmed.split("\n");
          const lang = lines[0]?.replace("```", "").trim() || "";
          const code = lines.slice(1, -1).join("\n");
          return (
            <div
              key={idx}
              className="my-3 rounded-xl border border-zinc-800 bg-[#090a0f] p-3 font-mono text-xs overflow-x-auto text-zinc-200"
            >
              {lang && (
                <div className="text-[10px] text-zinc-500 mb-1.5 font-semibold uppercase font-mono">
                  {lang}
                </div>
              )}
              <pre className="leading-normal">{code}</pre>
            </div>
          );
        }

        // Heading 3
        if (trimmed.startsWith("### ")) {
          return (
            <h4 key={idx} className="text-sm font-semibold text-zinc-100 pt-2">
              {trimmed.replace(/^###\s+/, "")}
            </h4>
          );
        }

        // Heading 2
        if (trimmed.startsWith("## ")) {
          return (
            <h3 key={idx} className="text-base font-semibold text-zinc-100 pt-3">
              {trimmed.replace(/^##\s+/, "")}
            </h3>
          );
        }

        // Bullet list
        if (
          trimmed.includes("\n- ") ||
          trimmed.startsWith("- ") ||
          trimmed.startsWith("* ")
        ) {
          const items = trimmed.split(/\n[-*]\s+/).filter(Boolean);
          return (
            <ul key={idx} className="list-disc pl-5 space-y-1.5 text-zinc-300">
              {items.map((it, i) => (
                <li key={i}>{it.replace(/^[-*]\s+/, "")}</li>
              ))}
            </ul>
          );
        }

        return <p key={idx}>{trimmed}</p>;
      })}
    </div>
  );
}

export function AgentStreamView({
  task,
  status,
  currentTurn,
  events,
  terminalBuffer,
  diff,
  pullRequestUrl,
  onSwitchTab,
}: AgentStreamViewProps) {
  const turnGroups = useProcessedStreamItems({
    events,
    terminalBuffer,
    task,
    currentTurn,
  });

  const scrollViewportRef = useRef<HTMLDivElement>(null);
  const [userHasScrolledUp, setUserHasScrolledUp] = useState(false);
  const [expandedThoughts, setExpandedThoughts] = useState<Record<string, boolean>>({});
  const [expandedCommands, setExpandedCommands] = useState<Record<string, boolean>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const isRunning = status === "running" || status === "provisioning" || status === "cloning";
  const isWaiting = status === "waiting_input";

  // Real token usage relayed by the Codex SDK runner (sums across turns)
  const tokenUsage = useMemo(() => {
    let input = 0;
    let output = 0;
    let cached = 0;
    for (const event of events) {
      if (event.type === "usage") {
        input += event.inputTokens;
        output += event.outputTokens;
        cached += event.cachedInputTokens ?? 0;
      }
    }
    return input + output > 0 ? { input, output, cached } : null;
  }, [events]);

  const formatTokens = (count: number): string =>
    count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);

  // Auto-scroll handler
  useEffect(() => {
    if (!userHasScrolledUp && scrollViewportRef.current) {
      scrollViewportRef.current.scrollTop = scrollViewportRef.current.scrollHeight;
    }
  }, [turnGroups, userHasScrolledUp, terminalBuffer]);

  const handleScroll = () => {
    if (!scrollViewportRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollViewportRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 60;
    setUserHasScrolledUp(!isAtBottom);
  };

  const scrollToBottom = () => {
    if (scrollViewportRef.current) {
      scrollViewportRef.current.scrollTo({
        top: scrollViewportRef.current.scrollHeight,
        behavior: "smooth",
      });
      setUserHasScrolledUp(false);
    }
  };

  const toggleThought = (id: string) => {
    setExpandedThoughts((prev) => ({
      ...prev,
      [id]: prev[id] === undefined ? false : !prev[id],
    }));
  };

  const toggleCommand = (id: string) => {
    setExpandedCommands((prev) => ({
      ...prev,
      [id]: prev[id] === undefined ? true : !prev[id],
    }));
  };

  const copyToClipboard = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      // Fallback
    }
  };

  // Active step text for status ribbon
  const activeStepText = useMemo(() => {
    if (status === "provisioning") return "Provisioning Firecracker microVM...";
    if (status === "cloning") return "Preparing workspace & git branch...";
    if (status === "waiting_input") return "Warm sandbox ready — enter follow-up";
    if (status === "completed") return "Task complete. Changes pushed.";
    if (status === "failed") return "Task run failed.";
    if (status === "cancelled") return "Task was cancelled.";

    const lastGroup = turnGroups[turnGroups.length - 1];
    if (lastGroup && lastGroup.items.length > 0) {
      const lastItem = lastGroup.items[lastGroup.items.length - 1];
      if (lastItem) {
        if (lastItem.type === "thought") return "Reasoning about solution...";
        if (lastItem.type === "command" && lastItem.status === "running")
          return `Running ${lastItem.command}`;
        if (lastItem.type === "file_edit")
          return `Modifying ${lastItem.filePath}...`;
        if (lastItem.type === "file_read")
          return `Reading ${lastItem.filePath}...`;
        if (lastItem.type === "search")
          return `Searching for "${lastItem.query}"...`;
      }
    }
    return `Codex executing in microVM...`;
  }, [status, turnGroups]);

  return (
    <div className="relative flex flex-col flex-1 h-full min-h-0 bg-[#08090d] text-zinc-100 overflow-hidden font-sans">
      {/* Stream Ribbon Header */}
      <div className="flex items-center justify-between gap-3 px-4 sm:px-6 py-2.5 bg-[#0b0c11] border-b border-[#1b1d28] shrink-0 text-xs">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-zinc-900 border border-zinc-700/80 font-mono text-[11px] text-zinc-300">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                isRunning
                  ? "bg-blue-400 animate-pulse"
                  : isWaiting
                  ? "bg-amber-400"
                  : status === "completed"
                  ? "bg-emerald-400"
                  : "bg-rose-400"
              }`}
            />
            {task.model}
          </span>

          {task.reasoningEffort && (
            <span className="hidden sm:inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-purple-950/60 border border-purple-800/60 font-mono text-[11px] text-purple-300">
              <Brain className="w-3 h-3 text-purple-400" />
              Reasoning: {task.reasoningEffort}
            </span>
          )}

          {tokenUsage && (
            <span
              className="hidden sm:inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-950/60 border border-emerald-800/60 font-mono text-[11px] text-emerald-300"
              title={`Input ${tokenUsage.input.toLocaleString()} · Output ${tokenUsage.output.toLocaleString()} · Cached ${tokenUsage.cached.toLocaleString()} tokens (reported by the Codex harness)`}
            >
              <Zap className="w-3 h-3 text-emerald-400" />
              {formatTokens(tokenUsage.input)} in · {formatTokens(tokenUsage.output)} out
              {tokenUsage.cached > 0 && (
                <span className="text-emerald-500/80">· {formatTokens(tokenUsage.cached)} cached</span>
              )}
            </span>
          )}

          <span className="text-zinc-400 truncate hidden md:inline text-xs">
            {activeStepText}
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {onSwitchTab && (
            <button
              type="button"
              onClick={() => onSwitchTab("terminal")}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-zinc-800 bg-zinc-900/80 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 text-xs font-mono transition-colors cursor-pointer"
              title="Open raw terminal output"
            >
              <Terminal className="w-3 h-3 text-zinc-400" />
              <span>Raw terminal</span>
            </button>
          )}

          {diff && onSwitchTab && (
            <button
              type="button"
              onClick={() => onSwitchTab("diff")}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-blue-900/40 bg-blue-950/30 hover:bg-blue-900/40 text-blue-300 text-xs font-mono transition-colors cursor-pointer"
            >
              <FileCode className="w-3 h-3 text-blue-400" />
              <span>View diff</span>
            </button>
          )}
        </div>
      </div>

      {/* Main Stream Activity Feed */}
      <div
        ref={scrollViewportRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-3 sm:px-6 py-6 space-y-6 scroll-smooth"
      >
        {turnGroups.map((group) => (
          <div key={`turn-${group.turn}`} className="max-w-4xl mx-auto space-y-4">
            {/* User Prompt Turn Card */}
            <div className="rounded-2xl border border-zinc-800 bg-[#0c0d13] p-4 sm:p-5 shadow-lg">
              <div className="flex items-center justify-between gap-3 mb-2.5">
                <div className="flex items-center gap-2">
                  <span className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-400 text-xs font-mono font-medium">
                    <Sparkles className="w-3 h-3 text-blue-400" />
                    Turn {group.turn}
                  </span>
                  <span className="text-xs text-zinc-500 font-mono">User prompt</span>
                </div>
                {group.turn === 1 && task.workingBranch && (
                  <div className="flex items-center gap-1.5 text-xs font-mono text-zinc-400">
                    <GitBranch className="w-3 h-3 text-zinc-500" />
                    <span className="text-blue-400 truncate max-w-xs">
                      {task.workingBranch}
                    </span>
                  </div>
                )}
              </div>
              <p className="text-xs sm:text-sm text-zinc-100 font-sans leading-relaxed select-text whitespace-pre-wrap">
                {group.prompt}
              </p>
            </div>

            {/* Turn Stream Items */}
            <div className="pl-2 sm:pl-4 space-y-3.5 relative before:absolute before:left-0 before:top-2 before:bottom-2 before:w-px before:bg-zinc-800/80">
              {group.items.map((item, itemIdx) => {
                // 1. REASONING & THOUGHT PROCESS CARD
                if (item.type === "thought") {
                  const isCollapsed = expandedThoughts[item.id] === false;
                  const firstSentence =
                    item.content?.split("\n")[0]?.slice(0, 120) || "Reasoning about solution...";

                  return (
                    <div
                      key={item.id}
                      className="rounded-xl border border-purple-900/30 bg-purple-950/10 p-3.5 transition-all shadow-xs"
                    >
                      <button
                        type="button"
                        onClick={() => toggleThought(item.id)}
                        className="w-full flex items-center justify-between gap-3 text-left cursor-pointer group"
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-lg bg-purple-900/40 border border-purple-700/50 text-purple-300">
                            <Brain className="w-3 h-3 text-purple-300" />
                          </span>
                          <span className="text-xs font-semibold text-purple-300 shrink-0">
                            Thinking
                          </span>
                          {isCollapsed && (
                            <span className="text-xs text-zinc-400 truncate hidden sm:inline">
                              · {firstSentence}
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-2 text-zinc-500 text-xs shrink-0">
                          <span className="text-[11px] font-mono text-purple-400/80 group-hover:text-purple-300 transition-colors">
                            {isCollapsed ? "Show reasoning" : "Hide reasoning"}
                          </span>
                          {isCollapsed ? (
                            <ChevronRight className="w-3.5 h-3.5 text-zinc-400" />
                          ) : (
                            <ChevronDown className="w-3.5 h-3.5 text-zinc-400" />
                          )}
                        </div>
                      </button>

                      {!isCollapsed && (
                        <div className="mt-3 pt-3 border-t border-purple-900/30 text-xs sm:text-sm text-zinc-300 leading-relaxed font-sans">
                          <MarkdownBlock text={item.content || ""} />
                        </div>
                      )}
                    </div>
                  );
                }

                // 2. COMPACT TOOL COMMAND CARD (Default Collapsed)
                if (item.type === "command") {
                  const isExpanded =
                    expandedCommands[item.id] ?? (item.status === "failed");
                  const hasOutput = Boolean(item.output && item.output.trim());
                  const lineCount = hasOutput
                    ? item.output!.split("\n").length
                    : 0;

                  return (
                    <div
                      key={item.id}
                      className="rounded-xl border border-zinc-800 bg-[#0d0e15] overflow-hidden shadow-xs"
                    >
                      <div className="flex items-center justify-between gap-3 p-2.5 bg-[#10121a]/80">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-lg bg-sky-950/60 border border-sky-800/60 text-sky-400">
                            <Terminal className="w-3 h-3" />
                          </span>
                          <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 shrink-0 font-semibold">
                            Run
                          </span>
                          <code className="text-xs font-mono font-medium text-sky-300 truncate">
                            {item.command}
                          </code>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          {item.status === "running" ? (
                            <span className="flex items-center gap-1.5 text-[11px] font-mono text-sky-400 bg-sky-950/60 border border-sky-800/40 px-2 py-0.5 rounded-full">
                              <Loader2 className="w-3 h-3 animate-spin" />
                              Running
                            </span>
                          ) : item.status === "failed" ? (
                            <span className="flex items-center gap-1 text-[11px] font-mono text-rose-400 bg-rose-950/60 border border-rose-800/40 px-2 py-0.5 rounded-full">
                              <AlertCircle className="w-3 h-3" />
                              Exit {item.exitCode ?? 1}
                            </span>
                          ) : (
                            <span className="flex items-center gap-1 text-[11px] font-mono text-emerald-400 bg-emerald-950/60 border border-emerald-800/40 px-2 py-0.5 rounded-full">
                              <CheckCircle2 className="w-3 h-3" />
                              Exit 0
                            </span>
                          )}

                          <button
                            type="button"
                            onClick={() => copyToClipboard(item.id, item.command || "")}
                            title="Copy command"
                            className="p-1 rounded-md text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors cursor-pointer"
                          >
                            {copiedId === item.id ? (
                              <Check className="w-3.5 h-3.5 text-emerald-400" />
                            ) : (
                              <Copy className="w-3.5 h-3.5" />
                            )}
                          </button>

                          {hasOutput && (
                            <button
                              type="button"
                              onClick={() => toggleCommand(item.id)}
                              className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors cursor-pointer text-[11px] font-mono"
                              title={isExpanded ? "Collapse output" : "Expand output"}
                            >
                              <span>{lineCount} lines</span>
                              {isExpanded ? (
                                <ChevronDown className="w-3.5 h-3.5 text-zinc-400" />
                              ) : (
                                <ChevronRight className="w-3.5 h-3.5 text-zinc-400" />
                              )}
                            </button>
                          )}
                        </div>
                      </div>

                      {hasOutput && isExpanded && (
                        <div className="p-3 bg-[#07080c] text-zinc-300 font-mono text-[11px] max-h-60 overflow-y-auto whitespace-pre-wrap select-text leading-relaxed border-t border-zinc-900">
                          {item.output}
                        </div>
                      )}
                    </div>
                  );
                }

                // 3. FILE EDIT CARD
                if (item.type === "file_edit") {
                  return (
                    <div
                      key={item.id}
                      className="flex items-center justify-between gap-3 p-3 rounded-xl border border-blue-900/30 bg-blue-950/15"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-lg bg-blue-900/40 border border-blue-700/50 text-blue-400">
                          <FileEdit className="w-3 h-3" />
                        </span>
                        <div className="min-w-0 flex items-center gap-2">
                          <span className="text-[10px] font-mono uppercase tracking-wider text-blue-400 font-semibold">
                            {item.changeKind === "add"
                              ? "Created"
                              : item.changeKind === "delete"
                              ? "Deleted"
                              : "Modified"}
                          </span>
                          <span className="text-xs font-mono font-medium text-zinc-200 truncate">
                            {item.filePath}
                          </span>
                        </div>
                      </div>

                      {diff && onSwitchTab && (
                        <button
                          type="button"
                          onClick={() => onSwitchTab("diff")}
                          className="flex items-center gap-1 text-[11px] font-mono text-blue-400 hover:text-blue-300 transition-colors cursor-pointer shrink-0"
                        >
                          <span>Review diff</span>
                          <ChevronRight className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  );
                }

                // 4. FILE READ CARD
                if (item.type === "file_read") {
                  return (
                    <div
                      key={item.id}
                      className="flex items-center gap-2.5 px-3 py-2 rounded-lg border border-zinc-800 bg-zinc-900/40 text-xs font-mono text-zinc-400"
                    >
                      <FileText className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                      <span className="text-zinc-500">Read</span>
                      <span className="text-zinc-300 truncate">{item.filePath}</span>
                    </div>
                  );
                }

                // 5. SEARCH CARD
                if (item.type === "search") {
                  return (
                    <div
                      key={item.id}
                      className="flex items-center gap-2.5 px-3 py-2 rounded-lg border border-amber-900/30 bg-amber-950/15 text-xs font-mono text-amber-300/90"
                    >
                      <Search className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                      <span className="text-amber-500/80">Search</span>
                      <span className="text-zinc-200 truncate font-semibold">
                        &quot;{item.query}&quot;
                      </span>
                    </div>
                  );
                }

                // 6. ASSISTANT OUTPUT TEXT (Desktop-like response)
                if (item.type === "message") {
                  const isLatest =
                    itemIdx === group.items.length - 1 && group.turn === currentTurn;
                  return (
                    <div
                      key={item.id}
                      className="rounded-xl border border-zinc-800 bg-[#0d0f17] p-4 shadow-sm"
                    >
                      <div className="flex items-center gap-2 mb-2.5 text-zinc-400 text-xs">
                        <Bot className="w-4 h-4 text-blue-400" />
                        <span className="font-semibold text-zinc-200">{task.model}</span>
                        <span className="text-zinc-600">·</span>
                        <span className="text-[11px] text-zinc-500">Response</span>
                      </div>
                      <MarkdownBlock text={item.content || ""} />
                      {isRunning && isLatest && (
                        <span className="inline-block w-2 h-4 ml-1 bg-blue-400 animate-pulse align-middle" />
                      )}
                    </div>
                  );
                }

                // 7. DIFF COMMIT NOTIFICATION
                if (item.type === "diff_update") {
                  return (
                    <div
                      key={item.id}
                      className="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl border border-blue-900/30 bg-blue-950/20 text-xs font-mono"
                    >
                      <div className="flex items-center gap-2 text-blue-400">
                        <FileCode className="w-3.5 h-3.5" />
                        <span className="font-semibold">Git working tree updated</span>
                      </div>
                      {onSwitchTab && (
                        <button
                          type="button"
                          onClick={() => onSwitchTab("diff")}
                          className="text-blue-400 hover:text-blue-300 underline cursor-pointer text-[11px]"
                        >
                          Inspect changes
                        </button>
                      )}
                    </div>
                  );
                }

                // 8. STATUS STEP
                if (item.type === "status_step") {
                  return (
                    <div
                      key={item.id}
                      className="flex items-center gap-2 text-xs font-mono text-zinc-400 px-2 py-1"
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
                      <span>{item.title}</span>
                    </div>
                  );
                }

                // 9. COMPLETION CARD
                if (item.type === "completed") {
                  return (
                    <div
                      key={item.id}
                      className="rounded-xl border border-emerald-500/30 bg-emerald-950/20 p-4 space-y-2 text-xs"
                    >
                      <div className="flex items-center gap-2 text-emerald-400 font-semibold text-sm">
                        <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                        <span>Turn {item.turn} Complete</span>
                      </div>
                      {item.content && (
                        <p className="text-zinc-300 font-sans leading-relaxed">
                          {item.content}
                        </p>
                      )}
                      {pullRequestUrl && (
                        <a
                          href={pullRequestUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium shadow-xs transition-colors mt-2"
                        >
                          <span>Open Pull Request</span>
                          <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                      )}
                    </div>
                  );
                }

                // 10. ERROR CARD
                if (item.type === "error") {
                  return (
                    <div
                      key={item.id}
                      className="rounded-xl border border-rose-900/50 bg-rose-950/20 p-4 space-y-1 text-xs"
                    >
                      <div className="flex items-center gap-2 text-rose-400 font-semibold">
                        <AlertCircle className="w-4 h-4" />
                        <span>Execution error</span>
                      </div>
                      <p className="text-rose-200/90 font-mono whitespace-pre-wrap">
                        {item.content}
                      </p>
                    </div>
                  );
                }

                return null;
              })}
            </div>
          </div>
        ))}

        {/* Live Active Status Indicator at bottom */}
        {isRunning && (
          <div className="max-w-4xl mx-auto flex items-center justify-between gap-3 p-3.5 rounded-xl border border-blue-500/30 bg-blue-950/20 shadow-lg shadow-blue-950/20 animate-pulse">
            <div className="flex items-center gap-3">
              <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />
              <span className="text-xs font-mono font-medium text-blue-300">
                {activeStepText}
              </span>
            </div>
            <span className="text-[11px] font-mono text-blue-400/80 hidden sm:inline">
              In-VM execution
            </span>
          </div>
        )}

        {isWaiting && (
          <div className="max-w-4xl mx-auto flex items-center justify-between gap-3 p-3.5 rounded-xl border border-amber-500/30 bg-amber-950/20">
            <div className="flex items-center gap-3">
              <Flame className="w-4 h-4 text-amber-400" />
              <span className="text-xs font-mono font-medium text-amber-300">
                Warm sandbox waiting for input. Enter follow-up prompt below.
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Floating Jump to Latest Button */}
      {userHasScrolledUp && (
        <button
          type="button"
          onClick={scrollToBottom}
          className="absolute bottom-6 right-6 flex items-center gap-1.5 px-3 py-2 rounded-full border border-zinc-700 bg-zinc-900/95 text-zinc-200 hover:text-white shadow-xl hover:bg-zinc-800 text-xs font-medium cursor-pointer transition-all z-20"
        >
          <ArrowDown className="w-3.5 h-3.5 text-blue-400" />
          <span>Jump to latest</span>
        </button>
      )}
    </div>
  );
}
