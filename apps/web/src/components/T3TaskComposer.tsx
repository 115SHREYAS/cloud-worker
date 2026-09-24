"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import {
  AVAILABLE_MODELS,
  type CreateTaskInput,
  type ReasoningEffort,
  type ModelOption,
} from "@cloud-worker/shared";
import {
  fetchGitHubBranches,
  fetchAvailableModels,
  type GitHubBranch,
} from "../lib/api";
import {
  ArrowUp,
  Paperclip,
  Lock,
  ChevronDown,
  GitBranch,
  FolderGit2,
  Check,
  Search,
  Loader2,
  Sparkles,
  Bot,
  RefreshCw,
  ArrowRight,
  Globe,
  SlidersHorizontal,
} from "lucide-react";

export interface InstalledRepoItem {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  installationId: number;
  private?: boolean;
}

export interface SelectedRepoRef {
  owner: string;
  repo: string;
  branch: string;
  installationId?: number;
}

interface T3TaskComposerProps {
  selectedRepo: SelectedRepoRef | null;
  availableRepos: InstalledRepoItem[];
  onSelectRepo: (repo: SelectedRepoRef) => void;
  onClearRepo?: () => void;
  onSubmit: (input: CreateTaskInput) => Promise<void>;
  isSubmitting: boolean;
  defaultModel?: string;
  defaultAuthMode?: string;
  onOpenSettings?: () => void;
}

function OpenAIIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.6667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
    </svg>
  );
}

function ClaudeIcon({ className = "w-3.5 h-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" />
    </svg>
  );
}

const PROMPT_CHIPS = [
  "Add a health check endpoint and test suite",
  "Refactor database queries for performance",
  "Fix authentication error handling and return codes",
  "Add input validation and sanitization for webhook payloads",
];

export function T3TaskComposer({
  selectedRepo,
  availableRepos,
  onSelectRepo,
  onClearRepo,
  onSubmit,
  isSubmitting,
  defaultModel = "codex",
  defaultAuthMode = "subscription",
  onOpenSettings,
}: T3TaskComposerProps) {
  const [prompt, setPrompt] = useState("");

  // Harness & Model selection
  const [harness, setHarness] = useState<"codex" | "claude">(() => {
    return defaultModel.toLowerCase().includes("claude") ? "claude" : "codex";
  });
  const [harnessModels, setHarnessModels] = useState<ModelOption[]>(() => {
    return AVAILABLE_MODELS.filter((m) =>
      defaultModel.toLowerCase().includes("claude")
        ? m.provider === "claude"
        : m.provider === "codex",
    );
  });
  const [selectedModelId, setSelectedModelId] = useState<string>(() => {
    const initial = AVAILABLE_MODELS.find((m) => m.id === defaultModel);
    if (initial) return initial.id;
    return defaultModel.toLowerCase().includes("claude")
      ? "claude-3-7-sonnet-20250219"
      : "codex";
  });
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>("medium");

  // Real Branches state
  const [branches, setBranches] = useState<GitHubBranch[]>([]);
  const [selectedBranch, setSelectedBranch] = useState<string>("main");
  const [isFetchingBranches, setIsFetchingBranches] = useState(false);
  const [branchSearch, setBranchSearch] = useState("");

  // Repo search for the prominent selection view
  const [repoSearch, setRepoSearch] = useState("");

  // Dropdown states
  const [isRepoPickerOpen, setIsRepoPickerOpen] = useState(false);
  const [isHarnessDropdownOpen, setIsHarnessDropdownOpen] = useState(false);
  const [isModelPickerOpen, setIsModelPickerOpen] = useState(false);
  const [isEffortPickerOpen, setIsEffortPickerOpen] = useState(false);
  const [isBranchPickerOpen, setIsBranchPickerOpen] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const repoDropdownRef = useRef<HTMLDivElement>(null);
  const harnessDropdownRef = useRef<HTMLDivElement>(null);
  const modelDropdownRef = useRef<HTMLDivElement>(null);
  const effortDropdownRef = useRef<HTMLDivElement>(null);
  const branchDropdownRef = useRef<HTMLDivElement>(null);

  // Fetch models whenever harness changes
  useEffect(() => {
    let ignore = false;
    async function loadModels() {
      try {
        const fetched = await fetchAvailableModels(harness);
        if (!ignore && fetched.length > 0) {
          setHarnessModels(fetched);
          // If current model not in fetched harness models, pick the first
          if (!fetched.some((m) => m.id === selectedModelId)) {
            setSelectedModelId(fetched[0].id);
            if (fetched[0].defaultEffort) {
              setReasoningEffort(fetched[0].defaultEffort);
            }
          }
        } else if (!ignore) {
          const fallback = AVAILABLE_MODELS.filter((m) => m.provider === harness);
          setHarnessModels(fallback);
          if (!fallback.some((m) => m.id === selectedModelId)) {
            setSelectedModelId(fallback[0].id);
          }
        }
      } catch {
        if (!ignore) {
          const fallback = AVAILABLE_MODELS.filter((m) => m.provider === harness);
          setHarnessModels(fallback);
        }
      }
    }
    loadModels();
    return () => {
      ignore = true;
    };
  }, [harness, selectedModelId]);

  // Fetch real branches from GitHub whenever selectedRepo changes
  useEffect(() => {
    if (!selectedRepo) {
      setBranches([]);
      return;
    }

    let ignore = false;
    setIsFetchingBranches(true);

    async function loadBranches() {
      try {
        const realBranches = await fetchGitHubBranches(
          selectedRepo!.owner,
          selectedRepo!.repo,
          selectedRepo!.installationId,
        );

        if (!ignore) {
          setBranches(realBranches);
          // If the current branch is not in the fetched branches, pick default
          const hasBranch = realBranches.some(
            (b) => b.name === selectedRepo!.branch,
          );
          if (hasBranch) {
            setSelectedBranch(selectedRepo!.branch);
          } else if (realBranches.length > 0) {
            setSelectedBranch(realBranches[0].name);
          } else {
            setSelectedBranch(selectedRepo!.branch || "main");
          }
        }
      } catch (err) {
        if (!ignore) {
          console.warn("Failed to load branches:", err);
          setSelectedBranch(selectedRepo!.branch || "main");
        }
      } finally {
        if (!ignore) {
          setIsFetchingBranches(false);
        }
      }
    }

    loadBranches();
    return () => {
      ignore = true;
    };
  }, [selectedRepo]);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(
        Math.max(textareaRef.current.scrollHeight, 100),
        320,
      )}px`;
    }
  }, [prompt]);

  // Close dropdowns on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        repoDropdownRef.current &&
        !repoDropdownRef.current.contains(e.target as Node)
      ) {
        setIsRepoPickerOpen(false);
      }
      if (
        harnessDropdownRef.current &&
        !harnessDropdownRef.current.contains(e.target as Node)
      ) {
        setIsHarnessDropdownOpen(false);
      }
      if (
        modelDropdownRef.current &&
        !modelDropdownRef.current.contains(e.target as Node)
      ) {
        setIsModelPickerOpen(false);
      }
      if (
        effortDropdownRef.current &&
        !effortDropdownRef.current.contains(e.target as Node)
      ) {
        setIsEffortPickerOpen(false);
      }
      if (
        branchDropdownRef.current &&
        !branchDropdownRef.current.contains(e.target as Node)
      ) {
        setIsBranchPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const selectedModelObj = useMemo(() => {
    return (
      harnessModels.find((m) => m.id === selectedModelId) ||
      AVAILABLE_MODELS.find((m) => m.id === selectedModelId) ||
      harnessModels[0] ||
      AVAILABLE_MODELS[0]
    );
  }, [harnessModels, selectedModelId]);

  const filteredRepos = useMemo(() => {
    if (!repoSearch.trim()) return availableRepos;
    const q = repoSearch.toLowerCase().trim();
    return availableRepos.filter(
      (r) =>
        r.fullName.toLowerCase().includes(q) ||
        r.name.toLowerCase().includes(q) ||
        r.owner.toLowerCase().includes(q),
    );
  }, [availableRepos, repoSearch]);

  const filteredBranches = useMemo(() => {
    if (!branchSearch.trim()) return branches;
    const q = branchSearch.toLowerCase().trim();
    return branches.filter((b) => b.name.toLowerCase().includes(q));
  }, [branches, branchSearch]);

  const handleSelectHarness = (newHarness: "codex" | "claude") => {
    setHarness(newHarness);
    setIsHarnessDropdownOpen(false);

    // Pick first model for this harness
    const newModels = AVAILABLE_MODELS.filter((m) => m.provider === newHarness);
    if (newModels.length > 0) {
      setSelectedModelId(newModels[0].id);
      if (newModels[0].defaultEffort) {
        setReasoningEffort(newModels[0].defaultEffort);
      }
    }
  };

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!selectedRepo) return;
    if (!prompt.trim() || isSubmitting) return;

    await onSubmit({
      repo: {
        owner: selectedRepo.owner,
        repo: selectedRepo.repo,
        branch: selectedBranch || selectedRepo.branch || "main",
        installationId: selectedRepo.installationId,
      },
      prompt: prompt.trim(),
      model: selectedModelId,
      reasoningEffort: selectedModelObj.supportsReasoning ? reasoningEffort : undefined,
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  // =========================================================================
  // VIEW 1: PROMINENT PROJECT SELECTOR (When no repository is selected)
  // =========================================================================
  if (!selectedRepo) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-4 py-12 sm:py-20 selection:bg-blue-500/20 selection:text-blue-300">
        <div className="w-full max-w-xl flex flex-col items-center">
          {/* Header Icon */}
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-blue-500/30 bg-blue-500/10 text-blue-400 shadow-[0_0_30px_rgba(59,130,246,0.15)]">
            <FolderGit2 className="h-7 w-7" />
          </div>

          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-zinc-100 text-center">
            Select a Project to Start
          </h1>
          <p className="mt-2 text-xs sm:text-sm text-zinc-400 text-center max-w-md leading-relaxed">
            Choose a connected GitHub repository. The autonomous agent will branch off your selected branch, implement code modifications, and open a Pull Request.
          </p>

          {/* Repo Selection Box */}
          <div className="mt-8 w-full rounded-2xl border border-[#1e202a] bg-[#0d0e13] p-4 shadow-[0_8px_32px_rgba(0,0,0,0.5)]">
            {/* Search Input */}
            <div className="relative mb-3">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-500" />
              <input
                type="text"
                value={repoSearch}
                onChange={(e) => setRepoSearch(e.target.value)}
                placeholder="Search connected repositories..."
                className="w-full rounded-xl border border-[#242634] bg-[#12131b] py-2 pl-9 pr-4 text-xs sm:text-sm text-zinc-200 placeholder-zinc-500 focus:border-blue-500 focus:outline-hidden transition-colors"
                autoFocus
              />
            </div>

            {/* Repository List */}
            <div className="max-h-72 overflow-y-auto space-y-1.5 pr-1">
              {filteredRepos.length > 0 ? (
                filteredRepos.map((repo) => (
                  <button
                    key={repo.id}
                    type="button"
                    onClick={() => {
                      onSelectRepo({
                        owner: repo.owner,
                        repo: repo.name,
                        branch: repo.defaultBranch || "main",
                        installationId: repo.installationId,
                      });
                      setSelectedBranch(repo.defaultBranch || "main");
                    }}
                    className="group flex w-full items-center justify-between p-3 rounded-xl border border-transparent bg-[#111218] hover:bg-[#161824] hover:border-blue-500/30 text-left transition-all cursor-pointer"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-zinc-800/80 text-zinc-400 group-hover:bg-blue-500/20 group-hover:text-blue-400 transition-colors shrink-0">
                        <FolderGit2 className="h-4 w-4" />
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs sm:text-sm font-semibold text-zinc-200 group-hover:text-white truncate">
                            {repo.fullName}
                          </span>
                          {repo.private ? (
                            <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[9px] font-mono text-zinc-400">
                              Private
                            </span>
                          ) : (
                            <span className="rounded bg-zinc-800/60 px-1.5 py-0.5 text-[9px] font-mono text-zinc-500">
                              Public
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 text-[11px] text-zinc-500 font-mono mt-0.5">
                          <GitBranch className="h-3 w-3 text-zinc-600" />
                          <span>{repo.defaultBranch || "main"}</span>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-1 text-xs text-blue-400 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                      <span>Select</span>
                      <ArrowRight className="h-3.5 w-3.5" />
                    </div>
                  </button>
                ))
              ) : (
                <div className="py-8 text-center text-xs text-zinc-500 space-y-2">
                  <p>No matching repositories found.</p>
                  {onOpenSettings && (
                    <button
                      type="button"
                      onClick={onOpenSettings}
                      className="inline-flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 font-medium cursor-pointer"
                    >
                      <span>Connect or configure GitHub App</span>
                      <ArrowRight className="h-3 w-3" />
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // =========================================================================
  // VIEW 2: T3 CODE COMPOSER (When a repository IS selected)
  // =========================================================================
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 py-8 sm:py-16 selection:bg-blue-500/20 selection:text-blue-300">
      <div className="w-full max-w-2xl flex flex-col items-center">
        {/* Top Active Repository Pill Banner */}
        <div className="mb-4 flex items-center gap-2 px-3 py-1 rounded-full border border-[#222430] bg-[#0c0d14] text-xs text-zinc-300">
          <div className="flex items-center gap-1.5">
            <FolderGit2 className="h-3.5 w-3.5 text-blue-400" />
            <span className="font-semibold text-white">
              {selectedRepo.owner}/{selectedRepo.repo}
            </span>
          </div>
          <span className="text-zinc-600">·</span>
          <div className="flex items-center gap-1 text-[11px] font-mono text-zinc-400">
            <GitBranch className="h-3 w-3 text-zinc-500" />
            <span>{selectedBranch}</span>
          </div>
          <span className="text-zinc-600">·</span>
          <button
            type="button"
            onClick={() => {
              if (onClearRepo) onClearRepo();
              else setIsRepoPickerOpen(true);
            }}
            className="text-[11px] font-medium text-blue-400 hover:text-blue-300 transition-colors cursor-pointer"
          >
            Change Project
          </button>
        </div>

        {/* Main Headline with Clickable Repo Dropdown (T3 Code inspired) */}
        <div className="relative mb-6 text-center" ref={repoDropdownRef}>
          <h1 className="text-2xl sm:text-4xl font-semibold tracking-tight text-zinc-100 flex items-center justify-center flex-wrap gap-2">
            <span>What should we build in</span>
            <button
              type="button"
              onClick={() => setIsRepoPickerOpen(!isRepoPickerOpen)}
              className="inline-flex items-center gap-1.5 font-bold text-white border-b-2 border-dotted border-blue-500/60 hover:border-blue-400 transition-colors cursor-pointer"
              title="Click to switch repository"
            >
              <span>{selectedRepo.repo}</span>
              <ChevronDown className="h-4 w-4 text-blue-400" />
            </button>
            <span>?</span>
          </h1>

          {/* Repo Selection Dropdown */}
          {isRepoPickerOpen && (
            <div className="absolute left-1/2 -translate-x-1/2 top-full mt-3 w-72 sm:w-80 rounded-xl border border-[#222430] bg-[#0d0e14] p-2 shadow-2xl z-30 text-left animate-in fade-in slide-in-from-top-1 duration-150">
              <div className="px-2 py-1 text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">
                Select Connected Repository
              </div>
              <div className="max-h-56 overflow-y-auto space-y-1 py-1">
                {availableRepos.map((r) => {
                  const isSelected =
                    r.owner.toLowerCase() === selectedRepo.owner.toLowerCase() &&
                    r.name.toLowerCase() === selectedRepo.repo.toLowerCase();

                  return (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => {
                        onSelectRepo({
                          owner: r.owner,
                          repo: r.name,
                          branch: r.defaultBranch || "main",
                          installationId: r.installationId,
                        });
                        setSelectedBranch(r.defaultBranch || "main");
                        setIsRepoPickerOpen(false);
                      }}
                      className={`flex w-full items-center justify-between px-2.5 py-1.5 rounded-lg text-xs transition-colors cursor-pointer ${
                        isSelected
                          ? "bg-[#181924] text-zinc-100 font-medium border border-blue-500/30"
                          : "text-zinc-400 hover:bg-[#13141c] hover:text-zinc-200"
                      }`}
                    >
                      <div className="flex items-center gap-2 truncate">
                        <FolderGit2 className="h-3.5 w-3.5 text-zinc-500 shrink-0" />
                        <span className="truncate">{r.fullName}</span>
                      </div>
                      {isSelected && <Check className="h-3.5 w-3.5 text-blue-400 shrink-0" />}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Central Composer Card (T3 Code style) */}
        <form
          onSubmit={handleSubmit}
          className="relative w-full rounded-2xl border border-[#1e202a] bg-[#0d0e13] p-3 sm:p-4 shadow-[0_4px_30px_rgba(0,0,0,0.5)] focus-within:border-zinc-700 transition-all"
        >
          {/* Main Textarea */}
          <textarea
            ref={textareaRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask for changes, send follow-ups, or describe a feature..."
            rows={3}
            className="w-full resize-none bg-transparent text-sm sm:text-base text-zinc-100 placeholder-zinc-500 focus:outline-hidden leading-relaxed"
          />

          {/* Bottom Action Bar inside composer box */}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[#1a1b24] pt-3">
            <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
              {/* Harness Selector (Codex vs Claude) */}
              <div className="relative" ref={harnessDropdownRef}>
                <button
                  type="button"
                  onClick={() => setIsHarnessDropdownOpen(!isHarnessDropdownOpen)}
                  className="flex items-center gap-1.5 rounded-lg border border-[#242634] bg-[#12131b] px-2.5 py-1 text-xs font-medium text-zinc-200 hover:bg-[#1a1b24] transition-colors cursor-pointer"
                  title="Switch Autonomous Agent Harness"
                >
                  {harness === "codex" ? (
                    <OpenAIIcon className="h-3 w-3 text-blue-400" />
                  ) : (
                    <ClaudeIcon className="h-3 w-3 text-amber-400" />
                  )}
                  <span>{harness === "codex" ? "OpenAI Codex" : "Claude Code"}</span>
                  <ChevronDown className="h-3 w-3 text-zinc-500" />
                </button>

                {isHarnessDropdownOpen && (
                  <div className="absolute left-0 bottom-full mb-2 w-48 rounded-xl border border-[#242634] bg-[#0d0e14] p-1.5 shadow-2xl z-30">
                    <div className="px-2 py-1 text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">
                      Select Agent Harness
                    </div>
                    <button
                      type="button"
                      onClick={() => handleSelectHarness("codex")}
                      className={`flex w-full items-center justify-between px-2.5 py-1.5 rounded-lg text-xs transition-colors cursor-pointer ${
                        harness === "codex"
                          ? "bg-[#181924] text-zinc-100 font-medium"
                          : "text-zinc-400 hover:bg-[#13141c] hover:text-zinc-200"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <OpenAIIcon className="h-3.5 w-3.5 text-blue-400" />
                        <span>OpenAI Codex</span>
                      </div>
                      {harness === "codex" && <Check className="h-3 w-3 text-blue-400" />}
                    </button>

                    <button
                      type="button"
                      onClick={() => handleSelectHarness("claude")}
                      className={`flex w-full items-center justify-between px-2.5 py-1.5 rounded-lg text-xs transition-colors cursor-pointer ${
                        harness === "claude"
                          ? "bg-[#181924] text-zinc-100 font-medium"
                          : "text-zinc-400 hover:bg-[#13141c] hover:text-zinc-200"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <ClaudeIcon className="h-3.5 w-3.5 text-amber-400" />
                        <span>Claude Code</span>
                      </div>
                      {harness === "claude" && <Check className="h-3 w-3 text-blue-400" />}
                    </button>
                  </div>
                )}
              </div>

              {/* Model Pill (Filtered by selected harness) */}
              <div className="relative" ref={modelDropdownRef}>
                <button
                  type="button"
                  onClick={() => setIsModelPickerOpen(!isModelPickerOpen)}
                  className="flex items-center gap-1.5 rounded-lg border border-[#242634] bg-[#12131b] px-2.5 py-1 text-xs font-medium text-zinc-200 hover:bg-[#1a1b24] transition-colors cursor-pointer"
                  title="Choose Model for Current Harness"
                >
                  <span>{selectedModelObj.name}</span>
                  <ChevronDown className="h-3 w-3 text-zinc-500" />
                </button>

                {isModelPickerOpen && (
                  <div className="absolute left-0 bottom-full mb-2 w-64 rounded-xl border border-[#242634] bg-[#0d0e14] p-1.5 shadow-2xl z-30">
                    <div className="px-2 py-1 text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">
                      {harness === "codex" ? "Codex Models" : "Claude Models"}
                    </div>
                    <div className="max-h-56 overflow-y-auto space-y-1">
                      {harnessModels.map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => {
                            setSelectedModelId(m.id);
                            if (m.defaultEffort) setReasoningEffort(m.defaultEffort);
                            setIsModelPickerOpen(false);
                          }}
                          className={`flex w-full items-center justify-between px-2.5 py-1.5 rounded-lg text-xs transition-colors cursor-pointer ${
                            m.id === selectedModelId
                              ? "bg-[#181924] text-zinc-100 font-medium"
                              : "text-zinc-400 hover:bg-[#13141c] hover:text-zinc-200"
                          }`}
                        >
                          <div className="flex flex-col text-left truncate mr-2">
                            <span className="truncate">{m.name}</span>
                            {m.badge && (
                              <span className="text-[10px] text-zinc-500 font-mono">
                                {m.badge}
                              </span>
                            )}
                          </div>
                          {m.id === selectedModelId && (
                            <Check className="h-3 w-3 text-blue-400 shrink-0" />
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Reasoning Effort Pill (if supported by chosen model) */}
              {selectedModelObj.supportsReasoning && (
                <div className="relative" ref={effortDropdownRef}>
                  <button
                    type="button"
                    onClick={() => setIsEffortPickerOpen(!isEffortPickerOpen)}
                    className="flex items-center gap-1.5 rounded-lg border border-[#242634] bg-[#12131b] px-2.5 py-1 text-xs font-medium text-zinc-300 hover:bg-[#1a1b24] transition-colors cursor-pointer capitalize"
                    title="Reasoning Effort Budget"
                  >
                    <span>{reasoningEffort} effort</span>
                    <ChevronDown className="h-3 w-3 text-zinc-500" />
                  </button>

                  {isEffortPickerOpen && (
                    <div className="absolute left-0 bottom-full mb-2 w-32 rounded-xl border border-[#242634] bg-[#0d0e14] p-1.5 shadow-2xl z-30">
                      {(["low", "medium", "high"] as ReasoningEffort[]).map((eff) => (
                        <button
                          key={eff}
                          type="button"
                          onClick={() => {
                            setReasoningEffort(eff);
                            setIsEffortPickerOpen(false);
                          }}
                          className={`flex w-full items-center justify-between px-2.5 py-1.5 rounded-lg text-xs capitalize transition-colors cursor-pointer ${
                            eff === reasoningEffort
                              ? "bg-[#181924] text-zinc-100 font-medium"
                              : "text-zinc-400 hover:bg-[#13141c] hover:text-zinc-200"
                          }`}
                        >
                          <span>{eff}</span>
                          {eff === reasoningEffort && (
                            <Check className="h-3 w-3 text-blue-400" />
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Real Branch Selector Dropdown */}
              <div className="relative" ref={branchDropdownRef}>
                <button
                  type="button"
                  onClick={() => setIsBranchPickerOpen(!isBranchPickerOpen)}
                  className="flex items-center gap-1.5 rounded-lg border border-[#242634] bg-[#12131b] px-2.5 py-1 text-xs font-mono text-zinc-300 hover:bg-[#1a1b24] transition-colors cursor-pointer"
                  title="Target Base Branch"
                >
                  <GitBranch className="h-3 w-3 text-blue-400" />
                  {isFetchingBranches ? (
                    <Loader2 className="h-3 w-3 animate-spin text-zinc-500" />
                  ) : (
                    <span>{selectedBranch}</span>
                  )}
                  <ChevronDown className="h-3 w-3 text-zinc-500" />
                </button>

                {isBranchPickerOpen && (
                  <div className="absolute left-0 bottom-full mb-2 w-60 rounded-xl border border-[#242634] bg-[#0d0e14] p-2 shadow-2xl z-30">
                    <div className="px-2 py-1 text-[10px] font-semibold text-zinc-500 uppercase tracking-wider flex items-center justify-between">
                      <span>Base Branch</span>
                      <span className="text-[9px] text-zinc-600 font-mono">
                        {branches.length} branches
                      </span>
                    </div>

                    <div className="relative my-1">
                      <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-zinc-500" />
                      <input
                        type="text"
                        value={branchSearch}
                        onChange={(e) => setBranchSearch(e.target.value)}
                        placeholder="Search branches..."
                        className="w-full rounded-md border border-[#242634] bg-[#101117] py-1 pl-6 pr-2 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-hidden"
                      />
                    </div>

                    <div className="max-h-48 overflow-y-auto space-y-1 py-1">
                      {filteredBranches.map((b) => (
                        <button
                          key={b.name}
                          type="button"
                          onClick={() => {
                            setSelectedBranch(b.name);
                            setIsBranchPickerOpen(false);
                          }}
                          className={`flex w-full items-center justify-between px-2 py-1.5 rounded-md text-xs font-mono transition-colors cursor-pointer ${
                            b.name === selectedBranch
                              ? "bg-[#181924] text-zinc-100 font-medium"
                              : "text-zinc-400 hover:bg-[#13141c] hover:text-zinc-200"
                          }`}
                        >
                          <span className="truncate">{b.name}</span>
                          {b.name === selectedBranch && (
                            <Check className="h-3 w-3 text-blue-400 shrink-0" />
                          )}
                        </button>
                      ))}
                    </div>

                    <div className="mt-1.5 border-t border-[#1c1d25] pt-1.5 px-2 text-[10px] text-zinc-500">
                      PR will be created against{" "}
                      <span className="text-blue-400 font-mono font-medium">
                        {selectedBranch}
                      </span>
                    </div>
                  </div>
                )}
              </div>

              {/* Isolated VM Mode Pill */}
              <div
                title="Executed inside ephemeral Linux microVM with strict egress firewall rules"
                className="flex items-center gap-1.5 rounded-lg border border-[#242634] bg-[#12131b] px-2.5 py-1 text-xs font-medium text-zinc-400"
              >
                <Lock className="h-3 w-3 text-blue-400" />
                <span>Isolated VM</span>
              </div>
            </div>

            {/* Right side of toolbar: prompt suggestions & circular blue submit button */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  if (!prompt) {
                    setPrompt(PROMPT_CHIPS[0]);
                  }
                }}
                title="Insert prompt suggestion"
                className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-[#181924] transition-colors cursor-pointer"
              >
                <Paperclip className="h-4 w-4" />
              </button>

              <button
                type="submit"
                disabled={!prompt.trim() || isSubmitting}
                className={`flex h-8 w-8 items-center justify-center rounded-full transition-all cursor-pointer ${
                  prompt.trim() && !isSubmitting
                    ? "bg-blue-600 text-white hover:bg-blue-500 shadow-[0_0_15px_rgba(37,99,235,0.4)]"
                    : "bg-[#181a24] text-zinc-600 cursor-not-allowed"
                }`}
                title="Dispatch agent task (Enter)"
              >
                {isSubmitting ? (
                  <Loader2 className="h-4 w-4 animate-spin text-white" />
                ) : (
                  <ArrowUp className="h-4 w-4 stroke-[2.5]" />
                )}
              </button>
            </div>
          </div>
        </form>

        {/* Quick Suggestion Chips under Composer */}
        <div className="mt-4 flex flex-wrap items-center justify-center gap-1.5 max-w-xl">
          {PROMPT_CHIPS.map((chip, idx) => (
            <button
              key={idx}
              type="button"
              onClick={() => setPrompt(chip)}
              className="rounded-full border border-[#1e202a] bg-[#0c0d12] px-3 py-1 text-xs text-zinc-400 hover:border-blue-500/40 hover:text-zinc-200 transition-colors cursor-pointer"
            >
              {chip}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
