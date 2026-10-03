"use client";

import { useState, useEffect } from "react";
import type { Task, TaskStatus } from "@cloud-worker/shared";
import { useTaskStream } from "../hooks/useTaskStream";
import { sendFollowUpPrompt, finishTaskSession } from "../lib/api";
import { TerminalView } from "./TerminalView";
import { AgentTimeline } from "./AgentTimeline";
import { DiffViewer } from "./DiffViewer";
import {
  Terminal as TerminalIcon,
  Brain,
  FileCode,
  StopCircle,
  GitBranch,
  FolderGit2,
  Sparkles,
  RefreshCw,
  ExternalLink,
  Flame,
  Clock,
  Send,
  Check,
} from "lucide-react";

interface TaskWorkspaceProps {
  task: Task;
  onRefresh?: () => void;
}

type TabType = "terminal" | "timeline" | "diff";

function useWarmCountdown(expiresAt?: string, isWaiting?: boolean) {
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

  useEffect(() => {
    if (!isWaiting) {
      setSecondsLeft(null);
      return;
    }

    const targetTime = expiresAt ? new Date(expiresAt).getTime() : Date.now() + 600_000;

    const tick = () => {
      const remaining = Math.max(0, Math.floor((targetTime - Date.now()) / 1000));
      setSecondsLeft(remaining);
    };

    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [expiresAt, isWaiting]);

  return secondsLeft;
}

function FollowUpComposer({
  taskId,
  status,
  currentTurn,
  queuedPrompt,
  warmExpiresAt,
  onRefresh,
}: {
  taskId: string;
  status: TaskStatus;
  currentTurn: number;
  queuedPrompt: string | null;
  warmExpiresAt?: string;
  onRefresh?: () => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isFinishing, setIsFinishing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const isWaiting = status === "waiting_input";
  const isRunning = status === "running" || status === "cloning" || status === "provisioning";
  const countdown = useWarmCountdown(warmExpiresAt, isWaiting);

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmed = prompt.trim();
    if (!trimmed || isSubmitting) return;

    setIsSubmitting(true);
    setNotice(null);
    try {
      const res = await sendFollowUpPrompt(taskId, trimmed);
      setPrompt("");
      setNotice(res.message);
      onRefresh?.();
      setTimeout(() => setNotice(null), 5000);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Failed to send follow-up prompt");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleFinish = async () => {
    if (isFinishing) return;
    setIsFinishing(true);
    try {
      await finishTaskSession(taskId);
      onRefresh?.();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Failed to finish task session");
    } finally {
      setIsFinishing(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const formatCountdown = (secs: number | null) => {
    if (secs === null) return "10:00";
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s < 10 ? "0" : ""}${s}`;
  };

  return (
    <div className="relative shrink-0 w-full bg-gradient-to-t from-[#08090d] via-[#08090d]/90 to-transparent pt-2 pb-4 px-3 sm:px-6">
      <div className="max-w-4xl mx-auto w-full">
        <form
          onSubmit={handleSubmit}
          className={`relative flex flex-col rounded-2xl transition-all duration-200 shadow-2xl shadow-black/80 backdrop-blur-xl ${
            isWaiting
              ? "bg-[#0d0e15]/95 border border-amber-500/30 shadow-amber-950/20 focus-within:border-amber-500/60 focus-within:ring-2 focus-within:ring-amber-500/20"
              : "bg-[#0d0f18]/95 border border-zinc-800/80 focus-within:border-blue-500/60 focus-within:ring-2 focus-within:ring-blue-500/20"
          }`}
        >
          {/* Integrated Queued Prompt Shelf */}
          {queuedPrompt && (
            <div className="flex items-center justify-between gap-3 px-4 py-2.5 bg-blue-950/50 border-b border-blue-500/20 rounded-t-2xl">
              <div className="flex items-center gap-2.5 min-w-0">
                <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-300 border border-blue-500/30 text-[10px] font-mono font-medium shrink-0">
                  <Clock className="w-3 h-3 text-blue-400" />
                  Turn {currentTurn + 1} Queued
                </span>
                <span className="text-zinc-200 text-xs font-mono truncate">
                  "{queuedPrompt}"
                </span>
              </div>
              <span className="text-[11px] text-zinc-400 font-sans shrink-0 hidden sm:inline">
                Executes as soon as current turn finishes
              </span>
            </div>
          )}

          {/* Warm Idle Status Header inside the Card */}
          {isWaiting && (
            <div className={`flex items-center justify-between gap-3 px-4 py-2.5 bg-amber-500/10 border-b border-amber-500/20 ${queuedPrompt ? "" : "rounded-t-2xl"}`}>
              <div className="flex items-center gap-2.5 text-xs text-amber-300 font-medium">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
                </span>
                <Flame className="w-3.5 h-3.5 text-amber-400" />
                <span>Warm microVM ready</span>
                <span className="font-mono text-[11px] px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-300">
                  {formatCountdown(countdown)} idle window
                </span>
              </div>

              <button
                type="button"
                onClick={handleFinish}
                disabled={isFinishing}
                className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-lg border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white transition-colors cursor-pointer disabled:opacity-50"
                title="Finalize pull request and tear down sandbox"
              >
                <Check className="w-3 h-3 text-blue-400" />
                <span>{isFinishing ? "Finishing..." : "Finish session"}</span>
              </button>
            </div>
          )}

          {/* Textarea Input Area */}
          <div className="p-3.5 pb-1">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={2}
              placeholder={
                isWaiting
                  ? "Instruct the agent in this warm sandbox (Enter to submit, Shift+Enter for newline)..."
                  : queuedPrompt
                  ? "Queue an additional instruction or modification..."
                  : "Type follow-up instructions to queue for the next turn..."
              }
              className="w-full bg-transparent text-zinc-100 placeholder:text-zinc-500 text-xs sm:text-sm font-sans focus:outline-none resize-none leading-relaxed min-h-[44px] max-h-[160px]"
            />
          </div>

          {/* Integrated Card Footer / Action Bar */}
          <div className="flex items-center justify-between px-3.5 pb-3 pt-1">
            <div className="flex items-center gap-2 text-zinc-500 text-[11px]">
              {isRunning && !queuedPrompt && (
                <span className="flex items-center gap-1.5 text-zinc-400 text-xs">
                  <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse"></span>
                  Turn {currentTurn} executing
                </span>
              )}
              <span className="hidden sm:inline-flex items-center gap-1 text-zinc-500 font-mono text-[10px]">
                <kbd className="px-1.5 py-0.5 rounded bg-zinc-800/80 border border-zinc-700 text-zinc-400">Enter</kbd>
                to {isWaiting ? "send" : "queue"}
                <span className="text-zinc-600">·</span>
                <kbd className="px-1.5 py-0.5 rounded bg-zinc-800/80 border border-zinc-700 text-zinc-400">Shift + Enter</kbd>
                newline
              </span>
            </div>

            <div className="flex items-center gap-2.5">
              {notice && (
                <span className="text-xs text-blue-400 animate-fade-in hidden sm:inline">
                  {notice}
                </span>
              )}
              <button
                type="submit"
                disabled={!prompt.trim() || isSubmitting}
                className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-medium text-white transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed shadow-xs ${
                  isWaiting
                    ? "bg-amber-600 hover:bg-amber-500 shadow-amber-900/30"
                    : "bg-blue-600 hover:bg-blue-500 shadow-blue-900/30"
                }`}
              >
                {isSubmitting ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                ) : isWaiting ? (
                  <Send className="w-3.5 h-3.5" />
                ) : (
                  <Clock className="w-3.5 h-3.5" />
                )}
                <span>
                  {isWaiting
                    ? "Send follow-up"
                    : queuedPrompt
                    ? "Queue another prompt"
                    : `Queue for Turn ${currentTurn + 1}`}
                </span>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

export function TaskWorkspace({ task, onRefresh }: TaskWorkspaceProps) {
  const [activeTab, setActiveTab] = useState<TabType>("terminal");
  const {
    status,
    events,
    terminalBuffer,
    diff,
    pullRequestUrl,
    isFinished,
    currentTurn,
    queuedPrompt,
    cancel,
    clearTerminal,
  } = useTaskStream(task.id, {
    initialStatus: task.status,
    initialTurn: task.currentTurn || 1,
    initialQueuedPrompt: task.queuedPrompt || null,
  });

  const effectivePullRequestUrl = pullRequestUrl || task.pullRequestUrl;

  const getStatusBadge = (st: TaskStatus) => {
    switch (st) {
      case "provisioning":
        return "bg-cyan-500/10 text-cyan-400 border-cyan-500/20 animate-pulse";
      case "cloning":
        return "bg-amber-500/10 text-amber-400 border-amber-500/20 animate-pulse";
      case "running":
        return "bg-blue-500/10 text-blue-400 border-blue-500/20 animate-pulse";
      case "waiting_input":
        return "bg-amber-500/10 text-amber-400 border-amber-500/30 animate-pulse";
      case "completed":
        return "bg-blue-500/10 text-blue-400 border-blue-500/20";
      case "failed":
        return "bg-rose-500/10 text-rose-400 border-rose-500/20";
      case "cancelled":
        return "bg-zinc-800 text-zinc-400 border-zinc-700";
      default:
        return "bg-zinc-800 text-zinc-300 border-zinc-700";
    }
  };

  const currentDiff = diff || task.diff || "";

  return (
    <div className="flex flex-col flex-1 h-full min-h-0 bg-[#08090d] overflow-hidden">
      {/* Task Header */}
      <div className="flex flex-col gap-3 p-3 sm:p-4 bg-[#0b0c10] border-b border-[#1c1d25] shrink-0">
        <div className="flex flex-wrap items-center justify-between gap-2.5 sm:gap-4">
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <span
              className={`text-xs font-mono font-semibold uppercase px-2 sm:px-2.5 py-0.5 sm:py-1 rounded-full border ${getStatusBadge(
                status,
              )}`}
            >
              {status === "waiting_input" ? "waiting input" : status}
            </span>
            <span className="text-xs font-mono px-2 py-0.5 rounded-full bg-zinc-850 text-zinc-300 border border-zinc-700">
              Turn {currentTurn}
            </span>
            <span className="text-xs font-mono text-zinc-500 hidden sm:inline">{task.id}</span>
            <div className="flex items-center gap-1.5 text-xs font-mono text-zinc-300">
              <FolderGit2 className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
              <span className="font-semibold text-zinc-100 truncate max-w-[180px] sm:max-w-none">
                {task.repo.owner}/{task.repo.repo}
              </span>
            </div>
            <div className="flex items-center gap-1 text-[11px] font-mono text-zinc-400">
              <GitBranch className="w-3 h-3 text-zinc-500 shrink-0" />
              <span>{task.repo.branch}</span>
              <span className="text-zinc-600">→</span>
              <span className="text-blue-400">{task.workingBranch}</span>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {onRefresh && (
              <button
                type="button"
                onClick={onRefresh}
                title="Refresh task"
                className="p-1.5 rounded-lg border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            )}

            {!isFinished && (
              <button
                type="button"
                onClick={() => cancel()}
                className="flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 text-xs font-medium rounded-lg border border-rose-900/60 bg-rose-950/40 hover:bg-rose-900/60 text-rose-300 transition-colors cursor-pointer"
              >
                <StopCircle className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Cancel execution</span>
                <span className="sm:hidden">Cancel</span>
              </button>
            )}

            {effectivePullRequestUrl && (
              <a
                href={effectivePullRequestUrl}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-500 text-white shadow-xs transition-colors"
              >
                <span>Pull request</span>
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            )}
          </div>
        </div>

        {/* Prompt Card */}
        <div className="flex items-start gap-2.5 sm:gap-3 p-2.5 sm:p-3 rounded-xl bg-[#0e0f15] border border-[#1f212c]">
          <Sparkles className="w-3.5 h-3.5 text-blue-400 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <span className="block text-[10px] font-medium text-zinc-500 uppercase tracking-wider mb-0.5">
              Instruction Prompt ({task.model})
            </span>
            <p className="text-xs text-zinc-200 leading-relaxed font-sans line-clamp-3 sm:line-clamp-none">{task.prompt}</p>
          </div>
        </div>

        {/* Workspace Navigation Tabs */}
        <div className="flex items-center gap-1.5 sm:gap-2 pt-2 border-t border-[#1c1d25] overflow-x-auto no-scrollbar">
          <button
            type="button"
            onClick={() => setActiveTab("terminal")}
            className={`flex items-center gap-1.5 sm:gap-2 px-2.5 sm:px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer shrink-0 ${
              activeTab === "terminal"
                ? "bg-[#181a24] text-zinc-100 border border-[#2c2f3e] shadow-xs"
                : "text-zinc-400 hover:text-zinc-200 hover:bg-[#12131b]"
            }`}
          >
            <TerminalIcon className="w-3.5 h-3.5 text-blue-400 shrink-0" />
            <span>Terminal stream</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("timeline")}
            className={`flex items-center gap-1.5 sm:gap-2 px-2.5 sm:px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer shrink-0 ${
              activeTab === "timeline"
                ? "bg-[#181a24] text-zinc-100 border border-[#2c2f3e] shadow-xs"
                : "text-zinc-400 hover:text-zinc-200 hover:bg-[#12131b]"
            }`}
          >
            <Brain className="w-3.5 h-3.5 text-purple-400 shrink-0" />
            <span>Agent reasoning</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-zinc-800 text-zinc-300 font-mono">
              {events.filter((e) => e.type !== "stdout" && e.type !== "stderr" && e.type !== "ping").length}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("diff")}
            className={`flex items-center gap-1.5 sm:gap-2 px-2.5 sm:px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer shrink-0 ${
              activeTab === "diff"
                ? "bg-[#181a24] text-zinc-100 border border-[#2c2f3e] shadow-xs"
                : "text-zinc-400 hover:text-zinc-200 hover:bg-[#12131b]"
            }`}
          >
            <FileCode className="w-3.5 h-3.5 text-blue-400 shrink-0" />
            <span>Git diff</span>
            {currentDiff && (
              <span className="w-2 h-2 rounded-full bg-blue-400 inline-block" />
            )}
          </button>
        </div>
      </div>

      {/* Tab Content Viewport */}
      <div className="flex-1 p-2 sm:p-6 overflow-y-auto min-h-0 flex flex-col">
        <div className={activeTab === "terminal" ? "flex-1 flex flex-col min-h-0" : "hidden"}>
          <TerminalView
            buffer={terminalBuffer}
            onClear={clearTerminal}
            status={status}
          />
        </div>

        {activeTab === "timeline" && (
          <div className="max-w-4xl mx-auto py-2">
            <AgentTimeline events={events} />
          </div>
        )}

        {activeTab === "diff" && (
          <div className="max-w-5xl mx-auto py-2">
            <DiffViewer diff={currentDiff} />
          </div>
        )}
      </div>

      {/* Follow-up Prompt Dialogue / Queue Composer */}
      {!isFinished && (
        <FollowUpComposer
          taskId={task.id}
          status={status}
          currentTurn={currentTurn}
          queuedPrompt={queuedPrompt}
          warmExpiresAt={task.warmExpiresAt}
          onRefresh={onRefresh}
        />
      )}
    </div>
  );
}
