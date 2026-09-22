"use client";

import type { Task, TaskStatus } from "@cloud-worker/shared";
import { Plus, KeyRound, RefreshCw, Cpu } from "lucide-react";

interface TaskSidebarProps {
  tasks: Task[];
  activeTaskId: string | null;
  onSelectTask: (taskId: string) => void;
  onNewTask: () => void;
  onOpenAuth: () => void;
  onRefresh: () => void;
  isLoading?: boolean;
}

export function TaskSidebar({
  tasks,
  activeTaskId,
  onSelectTask,
  onNewTask,
  onOpenAuth,
  onRefresh,
  isLoading,
}: TaskSidebarProps) {
  const getStatusDot = (st: TaskStatus) => {
    switch (st) {
      case "provisioning":
        return "bg-cyan-400 animate-ping";
      case "cloning":
        return "bg-amber-400 animate-pulse";
      case "running":
        return "bg-blue-400 animate-pulse";
      case "completed":
        return "bg-emerald-400";
      case "failed":
        return "bg-rose-400";
      case "cancelled":
        return "bg-zinc-500";
      default:
        return "bg-zinc-500";
    }
  };

  return (
    <aside className="w-80 h-full flex flex-col bg-zinc-950 border-r border-zinc-800 select-none shrink-0">
      {/* Brand Header */}
      <div className="flex items-center justify-between p-4 border-b border-zinc-800 bg-zinc-900/40">
        <div className="flex items-center gap-2.5">
          <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            <Cpu className="w-4 h-4" />
          </div>
          <div>
            <h1 className="text-sm font-semibold text-zinc-100">Cloud Worker</h1>
            <span className="text-[10px] text-zinc-400 font-mono">Agent Control Plane</span>
          </div>
        </div>

        <button
          type="button"
          onClick={onRefresh}
          disabled={isLoading}
          title="Refresh task list"
          className="p-1.5 rounded-lg border border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors cursor-pointer"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {/* New Task Action */}
      <div className="p-3 border-b border-zinc-800/80">
        <button
          type="button"
          onClick={onNewTask}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white shadow-xs transition-colors cursor-pointer"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>New coding task</span>
        </button>
      </div>

      {/* Tasks List */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {tasks.length === 0 ? (
          <div className="p-6 text-center text-xs text-zinc-500">
            <p>No tasks launched yet.</p>
            <p className="text-[11px] text-zinc-600 mt-1">
              Click &quot;New coding task&quot; to boot a microVM agent session.
            </p>
          </div>
        ) : (
          tasks.map((task) => {
            const isSelected = task.id === activeTaskId;
            const timeAgo = new Date(task.createdAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            });

            return (
              <button
                key={task.id}
                type="button"
                onClick={() => onSelectTask(task.id)}
                className={`w-full text-left p-3 rounded-lg border transition-all cursor-pointer ${
                  isSelected
                    ? "bg-zinc-900 border-zinc-700 shadow-xs"
                    : "border-transparent hover:bg-zinc-900/60 hover:border-zinc-800/60"
                }`}
              >
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="relative flex h-2 w-2">
                      <span className={`rounded-full h-2 w-2 ${getStatusDot(task.status)}`} />
                    </span>
                    <span className="text-xs font-semibold text-zinc-200 truncate font-mono">
                      {task.repo.owner}/{task.repo.repo}
                    </span>
                  </div>
                  <span className="text-[10px] text-zinc-500 font-mono shrink-0">{timeAgo}</span>
                </div>

                <p className="text-xs text-zinc-400 line-clamp-2 leading-relaxed mb-2 font-sans">
                  {task.prompt}
                </p>

                <div className="flex items-center justify-between text-[11px] text-zinc-500 font-mono">
                  <span className="truncate max-w-[130px]">{task.model}</span>
                  <span className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300 text-[10px] uppercase">
                    {task.status}
                  </span>
                </div>
              </button>
            );
          })
        )}
      </div>

      {/* Footer Settings */}
      <div className="p-3 border-t border-zinc-800 bg-zinc-900/30">
        <button
          type="button"
          onClick={onOpenAuth}
          className="w-full flex items-center justify-between px-3 py-2 text-xs rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900 border border-zinc-800/80 transition-colors cursor-pointer"
        >
          <div className="flex items-center gap-2">
            <KeyRound className="w-3.5 h-3.5 text-zinc-400" />
            <span>Subscription credentials</span>
          </div>
          <span className="text-[10px] font-mono text-emerald-400 font-medium">Config</span>
        </button>
      </div>
    </aside>
  );
}
