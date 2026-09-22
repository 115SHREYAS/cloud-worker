"use client";

import { useEffect, useState, useCallback } from "react";
import type { Task } from "@cloud-worker/shared";
import { fetchTasks } from "../lib/api";
import { TaskSidebar } from "../components/TaskSidebar";
import { TaskWorkspace } from "../components/TaskWorkspace";
import { TaskCreationModal } from "../components/TaskCreationModal";
import { AuthSettingsModal } from "../components/AuthSettingsModal";
import { Sparkles, Cpu } from "lucide-react";

export default function DashboardPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isAuthOpen, setIsAuthOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  const loadTasks = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await fetchTasks();
      setTasks(data);
      setActiveTaskId((curr) => curr || data[0]?.id || null);
    } catch (err) {
      console.error("Failed to load tasks:", err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    let ignore = false;
    async function init() {
      try {
        const data = await fetchTasks();
        if (!ignore) {
          setTasks(data);
          setActiveTaskId((curr) => curr || data[0]?.id || null);
          setIsLoading(false);
        }
      } catch (err) {
        if (!ignore) {
          console.error("Failed to load initial tasks:", err);
          setIsLoading(false);
        }
      }
    }

    init();
    return () => {
      ignore = true;
    };
  }, []);

  const activeTask = tasks.find((t) => t.id === activeTaskId) || null;

  const handleTaskCreated = (newTask: Task) => {
    setTasks((prev) => [newTask, ...prev]);
    setActiveTaskId(newTask.id);
  };

  return (
    <div className="flex h-screen w-screen bg-black text-zinc-100 overflow-hidden font-sans antialiased">
      {/* Sidebar */}
      <TaskSidebar
        tasks={tasks}
        activeTaskId={activeTaskId}
        onSelectTask={(id) => setActiveTaskId(id)}
        onNewTask={() => setIsCreateOpen(true)}
        onOpenAuth={() => setIsAuthOpen(true)}
        onRefresh={loadTasks}
        isLoading={isLoading}
      />

      {/* Main Workspace Area */}
      <main className="flex-1 flex flex-col h-full overflow-hidden">
        {activeTask ? (
          <TaskWorkspace
            key={activeTask.id}
            task={activeTask}
            onRefresh={loadTasks}
          />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center bg-zinc-950">
            <div className="max-w-md space-y-4">
              <div className="mx-auto flex items-center justify-center w-12 h-12 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                <Cpu className="w-6 h-6" />
              </div>
              <h2 className="text-lg font-semibold text-zinc-100">
                No coding task active
              </h2>
              <p className="text-xs text-zinc-400 leading-relaxed">
                Launch an autonomous coding agent session inside an isolated Firecracker microVM. The agent runs OpenAI Codex or Claude Code headlessly under your subscription quota.
              </p>
              <div className="pt-2">
                <button
                  type="button"
                  onClick={() => setIsCreateOpen(true)}
                  className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white shadow-xs transition-colors cursor-pointer"
                >
                  <Sparkles className="w-4 h-4" />
                  <span>Launch new task</span>
                </button>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Task Creation Modal */}
      <TaskCreationModal
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        onTaskCreated={handleTaskCreated}
      />

      {/* Auth Settings Modal */}
      <AuthSettingsModal
        isOpen={isAuthOpen}
        onClose={() => setIsAuthOpen(false)}
      />
    </div>
  );
}
