"use client";

import { useState } from "react";
import type { Task, TaskStatus } from "@cloud-worker/shared";
import { useTaskStream } from "../hooks/useTaskStream";
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
} from "lucide-react";

interface TaskWorkspaceProps {
  task: Task;
  onRefresh?: () => void;
}

type TabType = "terminal" | "timeline" | "diff";

export function TaskWorkspace({ task, onRefresh }: TaskWorkspaceProps) {
  const [activeTab, setActiveTab] = useState<TabType>("terminal");
  const {
    status,
    events,
    terminalBuffer,
    diff,
    pullRequestUrl,
    isFinished,
    cancel,
    clearTerminal,
  } = useTaskStream(task.id, {
    initialStatus: task.status,
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
              {status}
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
      <div className="flex-1 p-2 sm:p-6 overflow-y-auto">
        <div className={activeTab === "terminal" ? "h-full" : "hidden"}>
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
    </div>
  );
}
