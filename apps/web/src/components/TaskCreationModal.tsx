"use client";

import { useState, useEffect } from "react";
import { CreateTaskInputSchema, type CreateTaskInput, type Task } from "@cloud-worker/shared";
import { createTask, fetchGitHubRepositories } from "../lib/api";
import { X, Sparkles, AlertCircle, Loader2, GitBranch } from "lucide-react";

interface TaskCreationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onTaskCreated: (task: Task) => void;
}

interface InstalledRepoItem {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  installationId: number;
}

const SAMPLE_PROMPTS = [
  "Fix failing unit tests in the checkout service test suite",
  "Refactor token authentication middleware to use async/await",
  "Add input sanitization and unit tests for payment webhook endpoint",
];

export function TaskCreationModal({ isOpen, onClose, onTaskCreated }: TaskCreationModalProps) {
  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("main");
  const [installationId, setInstallationId] = useState<number | undefined>(undefined);
  const [installedRepos, setInstalledRepos] = useState<InstalledRepoItem[]>([]);
  const [selectedRepoKey, setSelectedRepoKey] = useState<string>("manual");
  const [isLoadingRepos, setIsLoadingRepos] = useState(true);
  const [model, setModel] = useState("codex");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    fetchGitHubRepositories()
      .then((repos) => {
        if (!cancelled && Array.isArray(repos)) {
          setInstalledRepos(repos);
        }
      })
      .catch(() => {
        // Silently fall back to manual entry if GitHub API fails
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingRepos(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen]);



  const handleSelectInstalledRepo = (key: string) => {
    setSelectedRepoKey(key);
    if (key === "manual") {
      setInstallationId(undefined);
      return;
    }
    const found = installedRepos.find((r) => String(r.id) === key);
    if (found) {
      setOwner(found.owner);
      setRepo(found.name);
      setBranch(found.defaultBranch || "main");
      setInstallationId(found.installationId);
    }
  };

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const payload: CreateTaskInput = {
      repo: {
        owner: owner.trim(),
        repo: repo.trim(),
        branch: branch.trim() || "main",
        installationId,
      },
      model,
      prompt: prompt.trim(),
    };


    const parsed = CreateTaskInputSchema.safeParse(payload);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setError(issue ? issue.message : "Validation failed");
      return;
    }

    setIsSubmitting(true);
    try {
      const task = await createTask(payload);
      onTaskCreated(task);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-xs">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-modal-title"
        className="w-full max-w-xl bg-zinc-950 border border-zinc-800 rounded-xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 bg-zinc-900/60">
          <div className="flex items-center gap-2.5">
            <span className="flex items-center justify-center w-7 h-7 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              <Sparkles className="w-4 h-4" />
            </span>
            <h2 id="create-modal-title" className="text-base font-semibold text-zinc-100">
              Create coding task
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          {error && (
            <div className="flex items-start gap-2.5 p-3 rounded-lg bg-rose-950/40 border border-rose-900/60 text-rose-300 text-xs">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Installed Repositories Picker (if available) */}
          {isLoadingRepos ? (
            <div className="h-10 rounded-lg bg-zinc-900/50 border border-zinc-800 flex items-center px-3 gap-2 text-xs text-zinc-500 animate-pulse">
              <GitBranch className="w-3.5 h-3.5 text-zinc-600" />
              <span>Checking connected GitHub repositories...</span>
            </div>
          ) : installedRepos.length > 0 ? (
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label htmlFor="installed-repo-select" className="text-xs font-medium text-zinc-300 flex items-center gap-1.5">
                  <GitBranch className="w-3.5 h-3.5 text-emerald-400" />
                  Select connected repository
                </label>
                <span className="text-[11px] text-zinc-500 font-normal">
                  {installedRepos.length} {installedRepos.length === 1 ? "repo" : "repos"} found
                </span>
              </div>
              <select
                id="installed-repo-select"
                value={selectedRepoKey}
                onChange={(e) => handleSelectInstalledRepo(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-100 focus:outline-hidden focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-colors"
              >
                <option value="manual">Manual repository input</option>
                {installedRepos.map((r) => (
                  <option key={r.id} value={String(r.id)}>
                    {r.fullName} ({r.defaultBranch || "main"})
                  </option>
                ))}
              </select>
            </div>
          ) : null}


          {/* Repo Owner & Name */}
          <div className="grid grid-cols-2 gap-3">

            <div>
              <label htmlFor="repo-owner" className="block text-xs font-medium text-zinc-300 mb-1.5">
                GitHub owner <span className="text-rose-400">*</span>
              </label>
              <input
                id="repo-owner"
                type="text"
                value={owner}
                onChange={(e) => setOwner(e.target.value)}
                placeholder="acme-corp"
                required
                className="w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-100 placeholder-zinc-500 focus:outline-hidden focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-colors"
              />
            </div>

            <div>
              <label htmlFor="repo-name" className="block text-xs font-medium text-zinc-300 mb-1.5">
                Repository name <span className="text-rose-400">*</span>
              </label>
              <input
                id="repo-name"
                type="text"
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
                placeholder="payment-service"
                required
                className="w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-100 placeholder-zinc-500 focus:outline-hidden focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-colors"
              />
            </div>
          </div>

          {/* Branch & Harness Model */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="repo-branch" className="block text-xs font-medium text-zinc-300 mb-1.5">
                Target branch
              </label>
              <input
                id="repo-branch"
                type="text"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder="main"
                className="w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-100 placeholder-zinc-500 focus:outline-hidden focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-colors"
              />
            </div>

            <div>
              <label htmlFor="agent-model" className="block text-xs font-medium text-zinc-300 mb-1.5">
                Agent harness
              </label>
              <select
                id="agent-model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-100 focus:outline-hidden focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-colors"
              >
                <option value="codex">OpenAI Codex CLI (Subscription tier)</option>
                <option value="claude-3-7-sonnet-20250219">Claude Code CLI (Claude tier)</option>
              </select>
            </div>
          </div>

          {/* Prompt */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label htmlFor="task-prompt" className="block text-xs font-medium text-zinc-300">
                Instruction prompt <span className="text-rose-400">*</span>
              </label>
              <span className="text-[11px] text-zinc-500">{prompt.length} chars</span>
            </div>
            <textarea
              id="task-prompt"
              rows={4}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Describe what the agent should implement, fix, or refactor in this repository..."
              required
              minLength={5}
              className="w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-100 placeholder-zinc-500 focus:outline-hidden focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-colors resize-none leading-relaxed"
            />
          </div>

          {/* Sample Prompts */}
          <div>
            <span className="block text-[11px] font-medium text-zinc-500 mb-2">
              Preset examples:
            </span>
            <div className="flex flex-wrap gap-1.5">
              {SAMPLE_PROMPTS.map((sample, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => setPrompt(sample)}
                  className="text-left text-[11px] px-2.5 py-1 rounded bg-zinc-900 hover:bg-zinc-800 border border-zinc-800/80 text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer"
                >
                  {sample}
                </button>
              ))}
            </div>
          </div>

          {/* Submit Actions */}
          <div className="flex items-center justify-end gap-3 pt-3 border-t border-zinc-800">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="px-4 py-2 text-xs font-medium rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors cursor-pointer disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting || prompt.trim().length < 5 || !owner.trim() || !repo.trim()}
              className="flex items-center gap-2 px-4 py-2 text-xs font-medium rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white shadow-xs transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Provisioning...</span>
                </>
              ) : (
                <span>Launch agent</span>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
