"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import type { Task, UserPublicProfile, CreateTaskInput } from "@cloud-worker/shared";
import {
  fetchTasks,
  getCurrentUser,
  logout,
  devLogin,
  createTask,
  fetchGitHubRepositories,
} from "../lib/api";
import { ProjectHistoryPanel } from "../components/ProjectHistoryPanel";
import {
  T3TaskComposer,
  type InstalledRepoItem,
  type SelectedRepoRef,
} from "../components/T3TaskComposer";
import { TaskWorkspace } from "../components/TaskWorkspace";
import { AuthSettingsModal } from "../components/AuthSettingsModal";
import { LandingWalkthrough } from "../components/LandingWalkthrough";
import {
  Loader2,
  Plus,
  GitBranch,
  Settings,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";

export default function DashboardPage() {
  const router = useRouter();
  const [currentUser, setCurrentUser] = useState<UserPublicProfile | null>(null);
  const [isAuthChecking, setIsAuthChecking] = useState(true);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [isAuthOpen, setIsAuthOpen] = useState(false);
  const [isHistoryPanelOpen, setIsHistoryPanelOpen] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmittingTask, setIsSubmittingTask] = useState(false);

  // Repositories state: null by default per user specification
  const [availableRepos, setAvailableRepos] = useState<InstalledRepoItem[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<SelectedRepoRef | null>(null);

  const loadTasks = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await fetchTasks();
      setTasks(data);
    } catch (err) {
      console.error("Failed to load tasks:", err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const loadRepositories = useCallback(async () => {
    try {
      const repos = await fetchGitHubRepositories();
      if (Array.isArray(repos) && repos.length > 0) {
        setAvailableRepos(repos);
        // Do NOT auto-select repository; user explicitly chooses their project
      }
    } catch (err) {
      console.warn("Could not fetch user repositories:", err);
    }
  }, []);

  // Initial session verification
  useEffect(() => {
    let ignore = false;
    async function initSession() {
      try {
        const user = await getCurrentUser();
        if (ignore) return;

        if (user) {
          if (!user.onboardingCompleted) {
            router.replace("/onboarding");
            return;
          }
          setCurrentUser(user);

          // Load tasks and connected repositories for user
          await Promise.all([loadTasks(), loadRepositories()]);
        } else {
          setCurrentUser(null);
        }
      } catch (err) {
        if (!ignore) {
          console.error("Session check error:", err);
          setCurrentUser(null);
        }
      } finally {
        if (!ignore) {
          setIsAuthChecking(false);
        }
      }
    }

    initSession();
    return () => {
      ignore = true;
    };
  }, [router, loadTasks, loadRepositories]);

  const handleDevLogin = async (username = "developer") => {
    setIsAuthChecking(true);
    try {
      const user = await devLogin(username);
      if (!user.onboardingCompleted) {
        router.push("/onboarding");
      } else {
        setCurrentUser(user);
        await Promise.all([loadTasks(), loadRepositories()]);
      }
    } catch (err) {
      console.error("Developer login failed:", err);
    } finally {
      setIsAuthChecking(false);
    }
  };

  const handleLogout = async () => {
    try {
      await logout();
      setCurrentUser(null);
      setTasks([]);
      setActiveTaskId(null);
      setSelectedRepo(null);
    } catch (err) {
      console.error("Failed to log out:", err);
      setCurrentUser(null);
    }
  };

  const handleWalkthrough = () => {
    router.push("/onboarding");
  };

  const handleCreateTask = async (input: CreateTaskInput) => {
    setIsSubmittingTask(true);
    try {
      const newTask = await createTask(input);
      setTasks((prev) => [newTask, ...prev]);
      setActiveTaskId(newTask.id);
      // Keep panel open so user sees the new thread in the project stack
      setIsHistoryPanelOpen(true);
    } catch (err) {
      console.error("Failed to create task:", err);
      alert(err instanceof Error ? err.message : "Failed to create task");
    } finally {
      setIsSubmittingTask(false);
    }
  };

  const handleNewTaskForProject = (repo: SelectedRepoRef) => {
    setSelectedRepo(repo);
    setActiveTaskId(null); // Return to composer with this project active
  };

  const handleNewTaskGlobal = () => {
    setActiveTaskId(null); // Return to composer
  };

  const activeTask = tasks.find((t) => t.id === activeTaskId) || null;

  if (isAuthChecking) {
    return (
      <div suppressHydrationWarning className="flex h-screen w-screen items-center justify-center bg-[#07080a] text-zinc-100">
        <div suppressHydrationWarning className="flex items-center gap-3 text-xs text-zinc-400 font-mono">
          <Loader2 className="h-4 w-4 animate-spin text-blue-400" />
          <span>Starting Cloud Worker Playground...</span>
        </div>
      </div>
    );
  }

  // If user is not authenticated, render the minimalist single-view landing page
  if (!currentUser) {
    return <LandingWalkthrough onDevLogin={handleDevLogin} />;
  }

  // Active project badge initials
  const currentProjectName = activeTask
    ? activeTask.repo.repo
    : selectedRepo
      ? selectedRepo.repo
      : "";
  const currentBranch = activeTask
    ? activeTask.repo.branch
    : selectedRepo
      ? selectedRepo.branch
      : "";
  const initials = (currentProjectName || "CW").slice(0, 2).toUpperCase();

  return (
    <div
      suppressHydrationWarning
      className="flex h-screen w-screen bg-[#07080a] text-zinc-100 overflow-hidden font-sans antialiased selection:bg-blue-500/20 selection:text-blue-300"
    >
      {/* Left Side History Panel (Project Stacks like T3 Code) */}
      <ProjectHistoryPanel
        tasks={tasks}
        activeTaskId={activeTaskId}
        onSelectTask={(id) => setActiveTaskId(id)}
        onNewTaskForProject={handleNewTaskForProject}
        onNewTaskGlobal={handleNewTaskGlobal}
        onOpenAuth={() => setIsAuthOpen(true)}
        onRefresh={loadTasks}
        isLoading={isLoading}
        currentUser={currentUser}
        onWalkthrough={handleWalkthrough}
        isOpen={isHistoryPanelOpen}
        onToggleOpen={() => setIsHistoryPanelOpen(!isHistoryPanelOpen)}
      />

      {/* Main Workspace Area (Right of history panel) */}
      <div className="flex-1 flex flex-col h-full min-w-0 overflow-hidden">
        {/* Top Navigation Bar (T3 Code inspired) */}
        <header className="flex h-13 w-full items-center justify-between border-b border-[#1c1d25] bg-[#090a0d] px-4 sm:px-6 shrink-0 z-20">
          {/* Breadcrumb Left & Panel Toggle */}
          <div className="flex items-center gap-2.5 min-w-0">
            <button
              type="button"
              onClick={() => setIsHistoryPanelOpen(!isHistoryPanelOpen)}
              title={isHistoryPanelOpen ? "Collapse sidebar" : "Expand sidebar"}
              className={`p-1.5 rounded-lg border transition-colors cursor-pointer ${
                isHistoryPanelOpen
                  ? "border-[#2b2d3d] bg-[#181924] text-zinc-200"
                  : "border-[#222430] bg-[#101117] text-zinc-400 hover:text-zinc-200 hover:bg-[#181924]"
              }`}
            >
              {isHistoryPanelOpen ? (
                <PanelLeftClose className="h-3.5 w-3.5" />
              ) : (
                <PanelLeftOpen className="h-3.5 w-3.5" />
              )}
            </button>

            <div className="flex items-center gap-2 min-w-0">
              <button
                type="button"
                onClick={handleNewTaskGlobal}
                className="flex items-center gap-2 text-left cursor-pointer group"
                title="Return to Task Composer"
              >
                <div className="flex h-6 w-6 items-center justify-center rounded-md bg-blue-500/20 text-blue-400 border border-blue-500/30 text-[10px] font-bold font-mono shrink-0">
                  {initials}
                </div>
                <span className="text-xs font-semibold text-zinc-200 group-hover:text-white transition-colors truncate max-w-[150px] sm:max-w-xs">
                  {currentProjectName || "Select Project"}
                </span>
              </button>

              <span className="text-xs text-zinc-600">/</span>

              <span className="text-xs font-medium text-zinc-400 truncate max-w-[180px] sm:max-w-sm">
                {activeTask
                  ? activeTask.prompt.split("\n")[0] || activeTask.id
                  : "New thread"}
              </span>
            </div>
          </div>

          {/* Action Buttons Right */}
          <div className="flex items-center gap-2 shrink-0">
            {/* New Thread CTA */}
            <button
              type="button"
              onClick={handleNewTaskGlobal}
              className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition-all cursor-pointer ${
                activeTaskId === null
                  ? "border-blue-500/40 bg-blue-600/15 text-blue-300 shadow-xs"
                  : "border-[#222430] bg-[#101117] text-zinc-300 hover:bg-[#181924] hover:text-white"
              }`}
            >
              <Plus className="h-3 w-3 text-blue-400" />
              <span>New thread</span>
            </button>

            {/* Branch indicator */}
            {currentBranch && (
              <div className="hidden sm:flex items-center gap-1 rounded-lg border border-[#222430] bg-[#101117] px-2 py-1 text-[11px] font-mono text-zinc-400">
                <GitBranch className="h-3 w-3 text-blue-400" />
                <span>{currentBranch}</span>
              </div>
            )}

            {/* Credentials / Settings Modal Trigger */}
            <button
              type="button"
              onClick={() => setIsAuthOpen(true)}
              title="Agent Credentials & Providers"
              className="p-1.5 rounded-lg border border-[#222430] bg-[#101117] text-zinc-400 hover:text-zinc-200 hover:bg-[#181924] transition-colors cursor-pointer"
            >
              <Settings className="h-3.5 w-3.5" />
            </button>
          </div>
        </header>

        {/* Main Canvas Area */}
        <main className="flex-1 flex flex-col h-full overflow-y-auto bg-[#07080a]">
          {activeTask ? (
            <TaskWorkspace
              key={activeTask.id}
              task={activeTask}
              onRefresh={loadTasks}
            />
          ) : (
            <T3TaskComposer
              selectedRepo={selectedRepo}
              availableRepos={availableRepos}
              onSelectRepo={(r) => setSelectedRepo(r)}
              onClearRepo={() => setSelectedRepo(null)}
              onSubmit={handleCreateTask}
              isSubmitting={isSubmittingTask}
              defaultModel={currentUser?.defaultModel || "codex"}
              defaultAuthMode={currentUser?.defaultAuthMode || "subscription"}
              onOpenSettings={() => setIsAuthOpen(true)}
            />
          )}
        </main>
      </div>

      {/* Auth & Credential Settings Modal */}
      <AuthSettingsModal
        isOpen={isAuthOpen}
        onClose={() => setIsAuthOpen(false)}
      />
    </div>
  );
}
