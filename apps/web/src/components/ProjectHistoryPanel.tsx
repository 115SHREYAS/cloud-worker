"use client";

import { useState, useMemo } from "react";
import type { Task, TaskStatus, UserPublicProfile } from "@cloud-worker/shared";
import {
  Search,
  Plus,
  ChevronDown,
  ChevronRight,
  FolderGit2,
  GitBranch,
  RefreshCw,
  Settings,
  CheckCircle2,
  X,
  Compass,
  PanelLeftClose,
  ExternalLink,
} from "lucide-react";

interface ProjectHistoryPanelProps {
  tasks: Task[];
  activeTaskId: string | null;
  onSelectTask: (taskId: string) => void;
  onNewTaskForProject?: (repo: { owner: string; repo: string; branch: string; installationId?: number }) => void;
  onNewTaskGlobal: () => void;
  onOpenAuth: () => void;
  onRefresh: () => void;
  isLoading?: boolean;
  currentUser?: UserPublicProfile | null;
  onWalkthrough?: () => void;
  isOpen: boolean;
  onToggleOpen: () => void;
}

interface ProjectStack {
  key: string;
  owner: string;
  repo: string;
  initials: string;
  badgeStyle: {
    bg: string;
    text: string;
    border: string;
  };
  tasks: Task[];
  activeTasks: Task[];
  settledTasks: Task[];
  lastActiveAt: number;
}

const BADGE_COLOR_PALETTES = [
  { bg: "bg-blue-500/15", text: "text-blue-400", border: "border-blue-500/30" },
  { bg: "bg-amber-500/15", text: "text-amber-400", border: "border-amber-500/30" },
  { bg: "bg-cyan-500/15", text: "text-cyan-400", border: "border-cyan-500/30" },
  { bg: "bg-purple-500/15", text: "text-purple-400", border: "border-purple-500/30" },
  { bg: "bg-indigo-500/15", text: "text-indigo-400", border: "border-indigo-500/30" },
  { bg: "bg-rose-500/15", text: "text-rose-400", border: "border-rose-500/30" },
];

function getProjectInitials(name: string): string {
  if (!name) return "CW";
  const clean = name.replace(/[^a-zA-Z0-9\s-_]/g, "");
  const parts = clean.split(/[-_\s]+/);
  if (parts.length >= 2 && parts[0] && parts[1]) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

function getBadgePalette(key: string) {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash << 5) - hash + key.charCodeAt(i);
  }
  const index = Math.abs(hash) % BADGE_COLOR_PALETTES.length;
  return BADGE_COLOR_PALETTES[index];
}

function formatRelativeTime(dateString: string): string {
  try {
    const ms = Date.now() - new Date(dateString).getTime();
    const minutes = Math.floor(ms / (1000 * 60));
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    return `${days}d`;
  } catch {
    return "";
  }
}

export function ProjectHistoryPanel({
  tasks,
  activeTaskId,
  onSelectTask,
  onNewTaskForProject,
  onNewTaskGlobal,
  onOpenAuth,
  onRefresh,
  isLoading,
  currentUser,
  onWalkthrough,
  isOpen,
  onToggleOpen,
}: ProjectHistoryPanelProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>({});
  const [isSettledExpanded, setIsSettledExpanded] = useState(false);

  // Group tasks into project stacks
  const projectStacks = useMemo(() => {
    const stacksMap = new Map<string, ProjectStack>();

    for (const task of tasks) {
      const owner = task.repo.owner || "local";
      const repo = task.repo.repo || "workspace";
      const key = `${owner}/${repo}`.toLowerCase();

      if (!stacksMap.has(key)) {
        stacksMap.set(key, {
          key,
          owner,
          repo,
          initials: getProjectInitials(repo),
          badgeStyle: getBadgePalette(key),
          tasks: [],
          activeTasks: [],
          settledTasks: [],
          lastActiveAt: 0,
        });
      }

      const stack = stacksMap.get(key)!;
      stack.tasks.push(task);

      const taskTime = new Date(task.createdAt).getTime() || 0;
      if (taskTime > stack.lastActiveAt) {
        stack.lastActiveAt = taskTime;
      }

      if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
        stack.settledTasks.push(task);
      } else {
        stack.activeTasks.push(task);
      }
    }

    return Array.from(stacksMap.values()).sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }, [tasks]);

  const filteredStacks = useMemo(() => {
    if (!searchQuery.trim()) return projectStacks;
    const q = searchQuery.toLowerCase().trim();

    return projectStacks
      .map((stack) => {
        const matchesProject =
          stack.repo.toLowerCase().includes(q) || stack.owner.toLowerCase().includes(q);

        const matchingTasks = stack.tasks.filter(
          (t) =>
            t.prompt.toLowerCase().includes(q) ||
            t.id.toLowerCase().includes(q) ||
            t.workingBranch.toLowerCase().includes(q),
        );

        if (matchesProject) {
          return stack;
        }

        if (matchingTasks.length > 0) {
          return {
            ...stack,
            tasks: matchingTasks,
            activeTasks: matchingTasks.filter(
              (t) => t.status !== "completed" && t.status !== "failed" && t.status !== "cancelled",
            ),
            settledTasks: matchingTasks.filter(
              (t) => t.status === "completed" || t.status === "failed" || t.status === "cancelled",
            ),
          };
        }

        return null;
      })
      .filter((s): s is ProjectStack => s !== null);
  }, [projectStacks, searchQuery]);

  const totalSettledCount = useMemo(() => {
    return tasks.filter(
      (t) => t.status === "completed" || t.status === "failed" || t.status === "cancelled",
    ).length;
  }, [tasks]);

  const toggleProject = (key: string) => {
    setCollapsedProjects((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  const getStatusIcon = (st: TaskStatus) => {
    switch (st) {
      case "provisioning":
      case "cloning":
        return <span className="h-2 w-2 rounded-full bg-cyan-400 animate-ping" />;
      case "running":
        return <span className="h-2 w-2 rounded-full bg-blue-500 animate-pulse" />;
      case "completed":
        return <span className="h-2 w-2 rounded-full bg-blue-400" />;
      case "failed":
        return <span className="h-2 w-2 rounded-full bg-rose-400" />;
      case "cancelled":
        return <span className="h-2 w-2 rounded-full bg-zinc-600" />;
      default:
        return <span className="h-2 w-2 rounded-full bg-zinc-500" />;
    }
  };

  return (
    <>
      {/* Mobile backdrop */}
      {isOpen && (
        <div
          role="presentation"
          onClick={onToggleOpen}
          className="fixed inset-0 z-40 bg-black/70 backdrop-blur-xs lg:hidden"
        />
      )}

      {/* Main Drawer Container on LEFT */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex h-full flex-col border-r border-[#1c1d25] bg-[#090a0d] text-zinc-100 select-none transition-all duration-200 ease-in-out shrink-0 lg:static ${
          isOpen
            ? "w-80 sm:w-84 translate-x-0"
            : "-translate-x-full lg:w-0 lg:-translate-x-full overflow-hidden"
        }`}
      >
        {/* Header with Search and New Chat */}
        <div className="flex flex-col gap-2.5 p-3.5 border-b border-[#1c1d25] bg-[#090a0d]">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold tracking-tight text-zinc-200">
                Project Threads
              </span>
              <span className="rounded-full bg-zinc-800/80 px-2 py-0.5 text-[10px] font-mono text-zinc-400">
                {tasks.length}
              </span>
            </div>

            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={onNewTaskGlobal}
                title="Create new task"
                className="flex items-center gap-1 rounded-md border border-[#262833] bg-[#12131a] px-2 py-1 text-xs font-medium text-zinc-300 hover:bg-[#1a1b24] hover:text-white transition-colors cursor-pointer"
              >
                <Plus className="h-3 w-3 text-blue-400" />
                <span>New</span>
              </button>

              <button
                type="button"
                onClick={onRefresh}
                disabled={isLoading}
                title="Refresh tasks"
                className="rounded-md border border-[#262833] bg-[#12131a] p-1.5 text-zinc-400 hover:text-zinc-200 hover:bg-[#1a1b24] transition-colors cursor-pointer"
              >
                <RefreshCw className={`h-3 w-3 ${isLoading ? "animate-spin" : ""}`} />
              </button>

              <button
                type="button"
                onClick={onToggleOpen}
                title="Collapse sidebar"
                className="rounded-md border border-[#262833] bg-[#12131a] p-1.5 text-zinc-400 hover:text-zinc-200 hover:bg-[#1a1b24] transition-colors cursor-pointer"
              >
                <PanelLeftClose className="h-3 w-3" />
              </button>
            </div>
          </div>

          {/* Search Bar */}
          <div className="relative w-full">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search threads..."
              className="w-full rounded-lg border border-[#222430] bg-[#101117] py-1.5 pl-8 pr-7 text-xs text-zinc-200 placeholder-zinc-500 focus:border-blue-500/60 focus:outline-hidden transition-colors"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>

        {/* Project Stacks List */}
        <div className="flex-1 overflow-y-auto px-2 py-3 space-y-3 divide-y divide-[#161720]/60">
          {filteredStacks.length === 0 ? (
            <div className="flex flex-col items-center justify-center p-8 text-center text-xs text-zinc-500 space-y-2">
              <FolderGit2 className="h-7 w-7 text-zinc-600 stroke-[1.5]" />
              <p className="font-medium text-zinc-400">No project threads found</p>
              <p className="text-[11px] text-zinc-500 max-w-[200px]">
                {searchQuery
                  ? "Try matching another keyword or repo name."
                  : "Launch your first task using the composer."}
              </p>
            </div>
          ) : (
            filteredStacks.map((stack) => {
              const isCollapsed = collapsedProjects[stack.key] ?? false;

              return (
                <div key={stack.key} className="pt-2 first:pt-0">
                  {/* Project Stack Header */}
                  <div className="group flex items-center justify-between px-2 py-1.5 rounded-lg hover:bg-[#12131a] transition-colors">
                    <button
                      type="button"
                      onClick={() => toggleProject(stack.key)}
                      className="flex items-center gap-2 min-w-0 flex-1 text-left cursor-pointer"
                    >
                      <div
                        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border text-[10px] font-bold font-mono ${stack.badgeStyle.bg} ${stack.badgeStyle.text} ${stack.badgeStyle.border}`}
                      >
                        {stack.initials}
                      </div>
                      <span className="text-xs font-semibold text-zinc-200 truncate">
                        {stack.repo}
                      </span>
                      <span className="text-[10px] text-zinc-500 font-mono">
                        {stack.tasks.length}
                      </span>
                    </button>

                    <div className="flex items-center gap-1 shrink-0">
                      {onNewTaskForProject && (
                        <button
                          type="button"
                          onClick={() =>
                            onNewTaskForProject({
                              owner: stack.owner,
                              repo: stack.repo,
                              branch: stack.tasks[0]?.repo.branch || "main",
                              installationId: stack.tasks[0]?.repo.installationId,
                            })
                          }
                          title={`New task in ${stack.repo}`}
                          className="opacity-0 group-hover:opacity-100 p-1 rounded-md text-zinc-400 hover:text-blue-400 hover:bg-[#1a1b24] transition-all cursor-pointer"
                        >
                          <Plus className="h-3 w-3" />
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => toggleProject(stack.key)}
                        className="p-1 text-zinc-500 hover:text-zinc-300 cursor-pointer"
                      >
                        {isCollapsed ? (
                          <ChevronRight className="h-3 w-3" />
                        ) : (
                          <ChevronDown className="h-3 w-3" />
                        )}
                      </button>
                    </div>
                  </div>

                  {/* Tasks inside this project stack */}
                  {!isCollapsed && (
                    <div className="mt-1 space-y-1 pl-2">
                      {stack.tasks.map((task) => {
                        const isCurrent = task.id === activeTaskId;
                        const timeAgo = formatRelativeTime(task.createdAt);

                        return (
                          <button
                            key={task.id}
                            type="button"
                            onClick={() => onSelectTask(task.id)}
                            className={`group relative flex w-full flex-col gap-1 rounded-lg px-2.5 py-2 text-left transition-all cursor-pointer ${
                              isCurrent
                                ? "bg-[#141624] border border-blue-500/40 text-zinc-100 shadow-xs"
                                : "hover:bg-[#111219] text-zinc-400 hover:text-zinc-200 border border-transparent"
                            }`}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-1.5 min-w-0">
                                {getStatusIcon(task.status)}
                                <span className="text-xs font-medium truncate leading-tight text-zinc-200">
                                  {task.prompt.split("\n")[0] || "Coding task"}
                                </span>
                              </div>
                              <span className="text-[10px] text-zinc-500 shrink-0 font-mono">
                                {timeAgo}
                              </span>
                            </div>

                            <div className="flex items-center justify-between text-[10px] text-zinc-500 font-mono pl-3.5">
                              <div className="flex items-center gap-1 truncate max-w-[170px]">
                                <GitBranch className="h-2.5 w-2.5 text-zinc-600 shrink-0" />
                                <span className="truncate">{task.repo.branch}</span>
                                {task.workingBranch && (
                                  <>
                                    <span className="text-zinc-600">→</span>
                                    <span className="text-zinc-400 truncate">
                                      {task.workingBranch.replace("agent/patch-", "patch-")}
                                    </span>
                                  </>
                                )}
                              </div>

                              {task.pullRequestUrl && (
                                <span className="text-blue-400 flex items-center gap-0.5 text-[9px] font-sans">
                                  PR <ExternalLink className="h-2 w-2" />
                                </span>
                              )}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })
          )}

          {/* Settled Group (Collapsible Completed section like T3 Code) */}
          {totalSettledCount > 0 && (
            <div className="pt-3 border-t border-[#161720]">
              <button
                type="button"
                onClick={() => setIsSettledExpanded(!isSettledExpanded)}
                className="flex w-full items-center justify-between px-2 py-1.5 text-xs font-medium text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer"
              >
                <div className="flex items-center gap-1.5">
                  <CheckCircle2 className="h-3.5 w-3.5 text-blue-400" />
                  <span>Settled ({totalSettledCount})</span>
                </div>
                {isSettledExpanded ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <ChevronRight className="h-3 w-3" />
                )}
              </button>

              {isSettledExpanded && (
                <div className="mt-1 space-y-1 pl-2">
                  {tasks
                    .filter(
                      (t) =>
                        t.status === "completed" ||
                        t.status === "failed" ||
                        t.status === "cancelled",
                    )
                    .slice(0, 15)
                    .map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => onSelectTask(t.id)}
                        className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-xs text-left transition-colors cursor-pointer ${
                          t.id === activeTaskId
                            ? "bg-[#141624] text-zinc-200 font-medium"
                            : "text-zinc-500 hover:bg-[#101117] hover:text-zinc-300"
                        }`}
                      >
                        <span className="truncate max-w-[200px]">
                          {t.prompt.split("\n")[0] || t.id}
                        </span>
                        <span className="text-[10px] text-zinc-600 font-mono">
                          {formatRelativeTime(t.createdAt)}
                        </span>
                      </button>
                    ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer with User info & Settings */}
        <div className="flex items-center justify-between p-3 border-t border-[#1c1d25] bg-[#090a0d]">
          <div className="flex items-center gap-2 min-w-0">
            {currentUser?.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={currentUser.avatarUrl}
                alt={currentUser.username}
                className="h-6 w-6 rounded-full border border-zinc-800 shrink-0"
              />
            ) : (
              <div className="h-6 w-6 rounded-full bg-blue-500/20 text-blue-400 border border-blue-500/30 flex items-center justify-center text-[10px] font-bold">
                {currentUser?.username?.slice(0, 2).toUpperCase() || "CW"}
              </div>
            )}
            <span className="text-xs font-medium text-zinc-300 truncate">
              {currentUser?.username || "developer"}
            </span>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            {onWalkthrough && (
              <button
                type="button"
                onClick={onWalkthrough}
                title="Revisit Walkthrough"
                className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-300 hover:bg-[#14151e] transition-colors cursor-pointer"
              >
                <Compass className="h-3.5 w-3.5" />
              </button>
            )}

            <button
              type="button"
              onClick={onOpenAuth}
              title="Provider & API Credentials"
              className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-300 hover:bg-[#14151e] transition-colors cursor-pointer"
            >
              <Settings className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
