"use client";

import { useEffect, useState, useCallback, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AVAILABLE_MODELS,
  type UserPublicProfile,
  type GitHubInstallation,
  type GitHubRepository,
  type CreateTaskInput,
  type ReasoningEffort,
} from "@cloud-worker/shared";
import {
  getCurrentUser,
  fetchGitHubStatus,
  fetchGitHubInstallations,
  fetchGitHubRepositories,
  linkGitHubInstallation,
  saveUserCredentials,
  updateOnboarding,
  createTask,
  detectLocalProviderCredentials,
  importLocalProviderCredentials,
  startProviderLoginFlow,
  fetchProviderFlowStatus,
  cancelProviderLoginFlow,
  type DetectedProviderAuth,
  type ProviderAuthFlow,
} from "../../lib/api";
import {
  Cpu,
  Terminal,
  GitPullRequest,
  Check,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Sparkles,
  Loader2,
  RefreshCw,
  AlertCircle,
  Server,
  FileCode,
  Copy,
  ExternalLink,
  BrainCircuit,
} from "lucide-react";

function GitHubIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
      />
    </svg>
  );
}

type Step = 1 | 2 | 3 | 4;

const SAMPLE_PROMPTS = [
  "Add a health check endpoint and unit test suite",
  "Refactor authentication middleware to use async/await",
  "Add input sanitization and unit tests for webhook payloads",
];

export default function OnboardingPage() {
  return (
    <Suspense
      fallback={
        <div suppressHydrationWarning className="flex min-h-screen w-full items-center justify-center bg-black text-zinc-100">
          <div suppressHydrationWarning className="flex items-center gap-3 text-sm text-zinc-400">
            <Loader2 className="h-4 w-4 animate-spin text-emerald-400" />
            <span>Loading walkthrough...</span>
          </div>
        </div>
      }
    >
      <OnboardingWizard />
    </Suspense>
  );
}

function OnboardingWizard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [currentUser, setCurrentUser] = useState<UserPublicProfile | null>(null);
  const [loadingUser, setLoadingUser] = useState(true);
  const [currentStep, setCurrentStep] = useState<Step>(1);

  // Step 2 state: GitHub
  const [installations, setInstallations] = useState<GitHubInstallation[]>([]);
  const [repositories, setRepositories] = useState<GitHubRepository[]>([]);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [installUrl, setInstallUrl] = useState<string>("https://github.com/apps/cloud-worker-app/installations/new");
  const [justLinked, setJustLinked] = useState(false);

  // Step 3 state: Agent Credentials
  const [selectedProvider, setSelectedProvider] = useState<"codex" | "claude">("codex");
  const [authMode, setAuthMode] = useState<"subscription" | "api_key">("subscription");
  const [credentialValue, setCredentialValue] = useState("");
  const [savingCredentials, setSavingCredentials] = useState(false);
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const [copiedCommand, setCopiedCommand] = useState(false);
  const [detectedAuths, setDetectedAuths] = useState<DetectedProviderAuth[]>([]);
  const [isImportingLocal, setIsImportingLocal] = useState(false);
  const [activeFlow, setActiveFlow] = useState<ProviderAuthFlow | null>(null);
  const [isStartingFlow, setIsStartingFlow] = useState(false);
  const [showManualPaste, setShowManualPaste] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);

  const handleCopyCode = useCallback((code: string) => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(code);
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2000);
    }
  }, []);

  const handleCopyCommand = useCallback((cmd: string) => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(cmd);
      setCopiedCommand(true);
      setTimeout(() => setCopiedCommand(false), 2000);
    }
  }, []);

  // Step 4 state: First Task
  const [taskOwner, setTaskOwner] = useState("");
  const [taskRepo, setTaskRepo] = useState("");
  const [taskBranch, setTaskBranch] = useState("main");
  const [taskPrompt, setTaskPrompt] = useState(SAMPLE_PROMPTS[0]);
  const [taskModel, setTaskModel] = useState<string>("codex");
  const [taskReasoningEffort, setTaskReasoningEffort] = useState<ReasoningEffort>("medium");
  const [launchingTask, setLaunchingTask] = useState(false);
  const [taskError, setTaskError] = useState<string | null>(null);

  const handleModelChange = (newModel: string) => {
    setTaskModel(newModel);
    const found = AVAILABLE_MODELS.find((m) => m.id === newModel);
    if (found?.defaultEffort) {
      setTaskReasoningEffort(found.defaultEffort);
    }
  };

  useEffect(() => {
    if (selectedProvider === "claude") {
      setTaskModel("claude-3-7-sonnet-20250219");
      setTaskReasoningEffort("medium");
    } else {
      setTaskModel("codex");
      setTaskReasoningEffort("medium");
    }
  }, [selectedProvider]);

  const selectedModelObj = AVAILABLE_MODELS.find((m) => m.id === taskModel);
  const codexModels = AVAILABLE_MODELS.filter((m) => m.provider === "codex");
  const claudeModels = AVAILABLE_MODELS.filter((m) => m.provider === "claude");

  // Step navigator with URL and localStorage sync
  const goToStep = useCallback((step: Step) => {
    setCurrentStep(step);
    if (typeof window !== "undefined") {
      try {
        localStorage.setItem("cw_onboarding_step", String(step));
        const url = new URL(window.location.href);
        url.searchParams.set("step", String(step));
        window.history.replaceState(null, "", url.toString());
      } catch (e) {
        console.warn("Failed to persist onboarding step:", e);
      }
    }
  }, []);

  // Load GitHub App info and repositories
  const refreshGitHubState = useCallback(async () => {
    setLoadingRepos(true);
    try {
      const [insts, repos, status] = await Promise.all([
        fetchGitHubInstallations().catch(() => []),
        fetchGitHubRepositories().catch(() => []),
        fetchGitHubStatus().catch(() => null),
      ]);
      setInstallations(insts);
      setRepositories(repos);
      if (status?.installUrl) {
        setInstallUrl(status.installUrl);
      }

      if (repos.length > 0) {
        setTaskOwner((prev) => prev || repos[0].owner);
        setTaskRepo((prev) => prev || repos[0].name);
        setTaskBranch((prev) => prev || repos[0].defaultBranch || "main");
      }
    } finally {
      setLoadingRepos(false);
    }
  }, []);

  // Load current user and initial state
  useEffect(() => {
    let ignore = false;
    async function loadInitialData() {
      try {
        const stepParam = searchParams.get("step");
        const installationId = searchParams.get("installation_id");
        const setupAction = searchParams.get("setup_action");

        let initialStep: Step = 1;
        if (installationId || setupAction) {
          initialStep = 2;
        } else if (stepParam && ["1", "2", "3", "4"].includes(stepParam)) {
          initialStep = parseInt(stepParam, 10) as Step;
        } else if (typeof window !== "undefined") {
          const saved = localStorage.getItem("cw_onboarding_step");
          if (saved && ["1", "2", "3", "4"].includes(saved)) {
            initialStep = parseInt(saved, 10) as Step;
          }
        }

        const user = await getCurrentUser();
        if (!ignore) {
          if (!user) {
            router.replace("/login");
            return;
          }
          setCurrentUser(user);
          if (user.defaultModel?.includes("claude")) {
            setSelectedProvider("claude");
          }
          if (user.defaultAuthMode) {
            setAuthMode(user.defaultAuthMode);
          }

          setCurrentStep(initialStep);
          if (typeof window !== "undefined") {
            try {
              localStorage.setItem("cw_onboarding_step", String(initialStep));
            } catch {}
          }

          if (installationId) {
            const parsedId = parseInt(installationId, 10);
            if (!isNaN(parsedId)) {
              linkGitHubInstallation(parsedId).then((ok) => {
                if (!ignore && ok) {
                  setJustLinked(true);
                  refreshGitHubState();
                }
              });
            }
          }
        }
      } catch (err) {
        if (!ignore) {
          console.error("Failed to load user in onboarding:", err);
          router.replace("/login");
        }
      } finally {
        if (!ignore) {
          setLoadingUser(false);
        }
      }
    }

    loadInitialData();
    return () => {
      ignore = true;
    };
  }, [router, searchParams, refreshGitHubState]);

  // Auto-refresh repositories when transitioning to step 2+
  useEffect(() => {
    if (currentStep < 2) return;
    refreshGitHubState();
  }, [currentStep, refreshGitHubState]);

  // Window focus listener: auto-refresh repositories if user returned from installing GitHub App
  useEffect(() => {
    const handleFocus = () => {
      if (currentStep >= 2) {
        refreshGitHubState();
      }
    };

    window.addEventListener("focus", handleFocus);
    return () => {
      window.removeEventListener("focus", handleFocus);
    };
  }, [currentStep, refreshGitHubState]);

  // Auto-detect local host credentials when reaching Step 3
  useEffect(() => {
    if (currentStep === 3) {
      detectLocalProviderCredentials().then(setDetectedAuths).catch(() => {});
    }
  }, [currentStep]);

  // Polling for active onboarding login flow
  useEffect(() => {
    if (!activeFlow || activeFlow.phase === "succeeded" || activeFlow.phase === "failed" || activeFlow.phase === "cancelled") {
      return;
    }

    const flowId = activeFlow.id;
    const interval = setInterval(async () => {
      try {
        const { flow } = await fetchProviderFlowStatus(flowId);
        setActiveFlow(flow);
        if (flow.phase === "succeeded") {
          clearInterval(interval);
          goToStep(4);
        } else if (flow.phase === "failed") {
          clearInterval(interval);
          setCredentialError(flow.error || "Authentication failed or timed out.");
        }
      } catch {
        // Ignore polling errors
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [activeFlow, goToStep]);

  const handleImportLocal = async (prov: "codex" | "claude") => {
    setCredentialError(null);
    setIsImportingLocal(true);
    try {
      await importLocalProviderCredentials(prov);
      goToStep(4);
    } catch (err) {
      setCredentialError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsImportingLocal(false);
    }
  };

  const handleStartSignIn = async () => {
    setCredentialError(null);
    setIsStartingFlow(true);
    try {
      const { flow } = await startProviderLoginFlow(selectedProvider);
      setActiveFlow(flow);
      if (flow.authorizationUrl && typeof window !== "undefined") {
        window.open(flow.authorizationUrl, "_blank", "noopener,noreferrer");
      }
    } catch (err) {
      setCredentialError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsStartingFlow(false);
    }
  };

  const handleCancelFlow = async () => {
    if (!activeFlow) return;
    try {
      await cancelProviderLoginFlow(activeFlow.id);
      setActiveFlow(null);
    } catch {
      setActiveFlow(null);
    }
  };

  // Handle saving credentials in Step 3
  const handleSaveCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    setCredentialError(null);

    if (!credentialValue.trim()) {
      setCredentialError("Please provide your session JSON or API key.");
      return;
    }

    setSavingCredentials(true);
    try {
      await saveUserCredentials({
        provider: selectedProvider,
        authMode,
        credential: credentialValue.trim(),
      });
      goToStep(4);
    } catch (err) {
      setCredentialError(err instanceof Error ? err.message : "Failed to save credentials.");
    } finally {
      setSavingCredentials(false);
    }
  };

  // Launch the sample task in Step 4 and finish onboarding
  const handleLaunchSampleTask = async (e: React.FormEvent) => {
    e.preventDefault();
    setTaskError(null);

    if (!taskOwner.trim() || !taskRepo.trim() || !taskPrompt.trim()) {
      setTaskError("Please provide repository details and a prompt.");
      return;
    }

    setLaunchingTask(true);
    try {
      const selectedModelObj = AVAILABLE_MODELS.find((m) => m.id === taskModel);

      // Mark onboarding as completed
      await updateOnboarding({
        onboardingCompleted: true,
        defaultModel: taskModel,
        defaultAuthMode: authMode,
      });

      // Launch the task
      const payload: CreateTaskInput = {
        repo: {
          owner: taskOwner.trim(),
          repo: taskRepo.trim(),
          branch: taskBranch.trim() || "main",
        },
        prompt: taskPrompt.trim(),
        model: taskModel,
        reasoningEffort: selectedModelObj?.supportsReasoning ? taskReasoningEffort : undefined,
      };

      await createTask(payload);
      if (typeof window !== "undefined") {
        try {
          localStorage.removeItem("cw_onboarding_step");
        } catch {}
      }
      router.push("/");
    } catch (err) {
      setTaskError(err instanceof Error ? err.message : "Failed to launch task.");
      setLaunchingTask(false);
    }
  };

  // Skip task and jump to dashboard
  const handleSkipToDashboard = async () => {
    if (typeof window !== "undefined") {
      try {
        localStorage.removeItem("cw_onboarding_step");
      } catch {}
    }
    try {
      await updateOnboarding({
        onboardingCompleted: true,
        defaultModel: taskModel,
        defaultAuthMode: authMode,
      });
      router.push("/");
    } catch {
      router.push("/");
    }
  };

  if (loadingUser) {
    return (
      <div suppressHydrationWarning className="flex min-h-screen w-full items-center justify-center bg-black text-zinc-100">
        <div suppressHydrationWarning className="flex items-center gap-3 text-sm text-zinc-400">
          <Loader2 className="h-4 w-4 animate-spin text-emerald-400" />
          <span>Loading walkthrough...</span>
        </div>
      </div>
    );
  }

  const stepsMeta = [
    { num: 1 as Step, title: "Architecture" },
    { num: 2 as Step, title: "GitHub App" },
    { num: 3 as Step, title: "Credentials" },
    { num: 4 as Step, title: "Sample task" },
  ];

  return (
    <div suppressHydrationWarning className="flex min-h-screen w-full flex-col justify-between bg-black text-zinc-100 selection:bg-emerald-500/20 selection:text-emerald-300">
      {/* Top Header */}
      <header className="flex h-14 w-full items-center justify-between border-b border-zinc-900 px-6 sm:px-10">
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg border border-emerald-500/20 bg-emerald-500/10 text-emerald-400">
            <Cpu className="h-4 w-4" />
          </div>
          <span className="text-sm font-semibold tracking-tight text-zinc-100">
            Cloud Worker
          </span>
          <span className="text-xs text-zinc-500 font-mono pl-2">
            First-time setup
          </span>
        </div>

        {currentUser && (
          <div className="flex items-center gap-2 text-xs text-zinc-400">
            <span>Signed in as</span>
            <span className="font-mono text-zinc-200">{currentUser.username}</span>
          </div>
        )}
      </header>

      {/* Main Wizard Container */}
      <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col px-4 py-8 sm:px-6">
        {/* Step Progress Bar */}
        <nav aria-label="Walkthrough progress" className="mb-8">
          <ol className="grid grid-cols-4 gap-2 border-b border-zinc-900 pb-4">
            {stepsMeta.map((s) => {
              const isActive = s.num === currentStep;
              const isPast = s.num < currentStep;
              return (
                <li key={s.num} className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      if (isPast) goToStep(s.num);
                    }}
                    disabled={!isPast}
                    className={`flex items-center gap-2 text-left transition-colors ${
                      isPast ? "cursor-pointer hover:text-zinc-200" : "cursor-default"
                    }`}
                  >
                    <span
                      className={`flex h-6 w-6 items-center justify-center rounded-md text-xs font-mono font-medium ${
                        isActive
                          ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/40"
                          : isPast
                          ? "bg-zinc-800 text-zinc-300"
                          : "bg-zinc-900 text-zinc-600"
                      }`}
                    >
                      {isPast ? <Check className="h-3.5 w-3.5" /> : s.num}
                    </span>
                    <span
                      className={`text-xs font-medium hidden sm:inline ${
                        isActive
                          ? "text-zinc-100"
                          : isPast
                          ? "text-zinc-400"
                          : "text-zinc-600"
                      }`}
                    >
                      {s.title}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>

        {/* Step 1: Architecture Primer */}
        {currentStep === 1 && (
          <div className="space-y-6">
            <div className="space-y-2">
              <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">
                How Cloud Worker executes autonomous coding agents
              </h1>
              <p className="text-sm text-zinc-400 max-w-2xl leading-relaxed">
                Cloud Worker is designed for heavy coding workflows that require real shell commands, test runners, and package installations without consuming your local machine resources.
              </p>
            </div>

            {/* Architecture diagram cards */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
              <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-5 space-y-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-emerald-500/20 bg-emerald-500/10 text-emerald-400">
                  <Server className="h-4 w-4" />
                </div>
                <h2 className="text-sm font-semibold text-zinc-200">
                  Isolated Firecracker microVMs
                </h2>
                <p className="text-xs text-zinc-400 leading-relaxed">
                  Every task boots an ephemeral Linux virtual machine in 2 seconds. The environment has its own kernel, filesystem, and network isolation, with metadata and internal IP egress blocked.
                </p>
              </div>

              <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-5 space-y-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-blue-500/20 bg-blue-500/10 text-blue-400">
                  <Terminal className="h-4 w-4" />
                </div>
                <h2 className="text-sm font-semibold text-zinc-200">
                  Headless in-VM agent harness
                </h2>
                <p className="text-xs text-zinc-400 leading-relaxed">
                  The microVM executes OpenAI Codex CLI or Claude Code CLI directly inside the Linux container, using your existing subscription session or API key.
                </p>
              </div>

              <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-5 space-y-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-amber-500/20 bg-amber-500/10 text-amber-400">
                  <FileCode className="h-4 w-4" />
                </div>
                <h2 className="text-sm font-semibold text-zinc-200">
                  Live terminal and event stream
                </h2>
                <p className="text-xs text-zinc-400 leading-relaxed">
                  View raw xterm.js stdout/stderr streams, structured agent reasoning, tool calls, and unified diffs rendered in real time over Server-Sent Events.
                </p>
              </div>

              <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-5 space-y-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-purple-500/20 bg-purple-500/10 text-purple-400">
                  <GitPullRequest className="h-4 w-4" />
                </div>
                <h2 className="text-sm font-semibold text-zinc-200">
                  Automated pull requests
                </h2>
                <p className="text-xs text-zinc-400 leading-relaxed">
                  When the agent finishes modifying files and verifying tests, it commits to a dedicated branch and opens a GitHub pull request on your behalf.
                </p>
              </div>
            </div>

            <div className="flex justify-end pt-4 border-t border-zinc-900">
              <button
                type="button"
                onClick={() => goToStep(2)}
                className="flex items-center gap-2 rounded-lg bg-emerald-600 px-5 py-2.5 text-xs font-medium text-white transition-colors hover:bg-emerald-500 cursor-pointer shadow-xs"
              >
                <span>Continue to GitHub setup</span>
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Connect GitHub App */}
        {currentStep === 2 && (
          <div className="space-y-6">
            <div className="space-y-2">
              <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">
                Connect your GitHub repositories
              </h1>
              <p className="text-sm text-zinc-400 max-w-2xl leading-relaxed">
                Install the Cloud Worker GitHub App to grant access to repositories where you want agents to work. You can select specific repositories or all repositories.
              </p>
            </div>

            {justLinked && (
              <div className="flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 text-xs text-emerald-300">
                <Check className="h-4 w-4 shrink-0 text-emerald-400" />
                <span>GitHub repository access granted and linked successfully.</span>
              </div>
            )}

            <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-6 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="space-y-1">
                  <h2 className="text-sm font-semibold text-zinc-200">
                    GitHub App installation
                  </h2>
                  <p className="text-xs text-zinc-400 leading-normal">
                    {installations.length > 0
                      ? `${installations.length} GitHub installation(s) linked to your account.`
                      : "No installations linked yet. Click the button to authorize Cloud Worker on GitHub."}
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={refreshGitHubState}
                    disabled={loadingRepos}
                    className="p-2 rounded-lg border border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900 transition-colors cursor-pointer"
                    title="Refresh repositories"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${loadingRepos ? "animate-spin" : ""}`} />
                  </button>

                  <a
                    href={`${installUrl}?state=${currentUser?.id || ""}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-2 rounded-lg bg-zinc-100 px-4 py-2 text-xs font-medium text-black hover:bg-zinc-200 transition-colors cursor-pointer"
                  >
                    <GitHubIcon className="h-3.5 w-3.5" />
                    <span>Install Cloud Worker on GitHub</span>
                  </a>
                </div>
              </div>

              {/* Repositories display */}
              {loadingRepos ? (
                <div className="flex items-center justify-center p-8 text-xs text-zinc-500">
                  <Loader2 className="h-4 w-4 animate-spin mr-2 text-emerald-400" />
                  <span>Checking connected repositories...</span>
                </div>
              ) : repositories.length > 0 ? (
                <div className="space-y-2 pt-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-zinc-300">
                      Connected repositories ({repositories.length})
                    </span>
                    <span className="text-[11px] text-emerald-400 flex items-center gap-1 font-mono">
                      <Check className="h-3 w-3" /> Ready
                    </span>
                  </div>
                  <div className="max-h-48 overflow-y-auto rounded-lg border border-zinc-800/80 bg-zinc-900/40 p-2 divide-y divide-zinc-800/50">
                    {repositories.map((r) => (
                      <div key={r.id} className="py-2 px-3 flex items-center justify-between text-xs">
                        <span className="font-mono text-zinc-200">{r.fullName}</span>
                        <span className="text-[11px] text-zinc-500 font-mono">
                          branch: {r.defaultBranch || "main"}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-zinc-800 p-6 text-center text-xs text-zinc-500 space-y-1">
                  <p>No repositories connected yet.</p>
                  <p className="text-[11px] text-zinc-600">
                    You can install the GitHub App now, or proceed and enter repository paths manually.
                  </p>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between pt-4 border-t border-zinc-900">
              <button
                type="button"
                onClick={() => goToStep(1)}
                className="rounded-lg px-4 py-2 text-xs font-medium text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900 transition-colors cursor-pointer"
              >
                Back
              </button>

              <div className="flex items-center gap-3">
                {repositories.length === 0 && (
                  <button
                    type="button"
                    onClick={() => goToStep(3)}
                    className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
                  >
                    Skip repository linking for now
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => goToStep(3)}
                  className="flex items-center gap-2 rounded-lg bg-emerald-600 px-5 py-2.5 text-xs font-medium text-white transition-colors hover:bg-emerald-500 cursor-pointer shadow-xs"
                >
                  <span>Continue to agent credentials</span>
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Step 3: Default Agent & Credentials */}
        {currentStep === 3 && (
          <div className="space-y-6">
            <div className="space-y-2">
              <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">
                Configure your default agent and credentials
              </h1>
              <p className="text-sm text-zinc-400 max-w-2xl leading-relaxed">
                Select your preferred coding agent harness. You can run under your existing subscription quota at zero API cost, or bring your own API keys.
              </p>
            </div>

            <form onSubmit={handleSaveCredentials} className="space-y-6">
              {credentialError && (
                <div className="flex items-center gap-2 rounded-lg border border-rose-900/60 bg-rose-950/40 p-3 text-xs text-rose-300">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span>{credentialError}</span>
                </div>
              )}

              {/* Provider Selection */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <button
                  type="button"
                  onClick={() => setSelectedProvider("codex")}
                  className={`p-4 rounded-xl border text-left transition-all cursor-pointer ${
                    selectedProvider === "codex"
                      ? "border-emerald-500/80 bg-zinc-900/90 shadow-xs"
                      : "border-zinc-800 bg-zinc-950 hover:bg-zinc-900/50"
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-semibold text-zinc-100">
                      OpenAI Codex CLI
                    </span>
                    {selectedProvider === "codex" && (
                      <span className="h-2 w-2 rounded-full bg-emerald-400" />
                    )}
                  </div>
                  <p className="text-xs text-zinc-400 leading-relaxed">
                    Uses OpenAI Codex with o3-mini or GPT-4o models. Supports ChatGPT Plus, Pro, and Team subscriptions.
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => setSelectedProvider("claude")}
                  className={`p-4 rounded-xl border text-left transition-all cursor-pointer ${
                    selectedProvider === "claude"
                      ? "border-emerald-500/80 bg-zinc-900/90 shadow-xs"
                      : "border-zinc-800 bg-zinc-950 hover:bg-zinc-900/50"
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-semibold text-zinc-100">
                      Claude Code CLI
                    </span>
                    {selectedProvider === "claude" && (
                      <span className="h-2 w-2 rounded-full bg-emerald-400" />
                    )}
                  </div>
                  <p className="text-xs text-zinc-400 leading-relaxed">
                    Uses Anthropic Claude 3.7 Sonnet agent harness. Supports Claude Pro and Team subscriptions or Anthropic API keys.
                  </p>
                </button>
              </div>

              {/* Auth Mode Toggle */}
              <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-xs font-semibold text-zinc-200">
                      Authentication style
                    </h2>
                    <p className="text-xs text-zinc-400">
                      Choose how the agent authenticates inside the microVM.
                    </p>
                  </div>

                  <div className="flex rounded-lg border border-zinc-800 bg-zinc-900 p-0.5 text-xs">
                    <button
                      type="button"
                      onClick={() => setAuthMode("subscription")}
                      className={`px-3 py-1.5 rounded-md font-medium transition-colors cursor-pointer ${
                        authMode === "subscription"
                          ? "bg-zinc-800 text-zinc-100 shadow-xs"
                          : "text-zinc-400 hover:text-zinc-200"
                      }`}
                    >
                      Subscription session
                    </button>
                    <button
                      type="button"
                      onClick={() => setAuthMode("api_key")}
                      className={`px-3 py-1.5 rounded-md font-medium transition-colors cursor-pointer ${
                        authMode === "api_key"
                          ? "bg-zinc-800 text-zinc-100 shadow-xs"
                          : "text-zinc-400 hover:text-zinc-200"
                      }`}
                    >
                      API key
                    </button>
                  </div>
                </div>

                {authMode === "subscription" ? (
                  <div className="space-y-4 pt-2">
                    {/* 1. Local Auto-Detection Banner */}
                    {detectedAuths.find((d) => d.provider === selectedProvider) && (
                      <div className="rounded-xl border border-emerald-500/30 bg-emerald-950/20 p-4 space-y-3">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <Sparkles className="h-4 w-4 text-emerald-400" />
                            <span className="text-xs font-semibold text-emerald-200">
                              {detectedAuths.find((d) => d.provider === selectedProvider)?.planName} Detected Locally
                            </span>
                          </div>
                          <span className="text-[10px] font-mono text-emerald-400/80 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                            {detectedAuths.find((d) => d.provider === selectedProvider)?.source}
                          </span>
                        </div>
                        <p className="text-xs text-zinc-300 leading-relaxed">
                          We found an active {selectedProvider === "codex" ? "ChatGPT / Codex" : "Claude Code"} session on this machine
                          {detectedAuths.find((d) => d.provider === selectedProvider)?.email
                            ? ` (${detectedAuths.find((d) => d.provider === selectedProvider)?.email})`
                            : ""}
                          . Connect instantly with zero configuration.
                        </p>
                        <button
                          type="button"
                          onClick={() => handleImportLocal(selectedProvider)}
                          disabled={isImportingLocal}
                          className="flex items-center gap-2 px-3.5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium cursor-pointer transition-colors shadow-xs disabled:opacity-50"
                        >
                          {isImportingLocal ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                          <span>Connect from Local Session & Continue</span>
                        </button>
                      </div>
                    )}

                    {/* 2. Interactive Browser Sign-In Card */}
                    {!activeFlow ? (
                      <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 space-y-3">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-semibold text-zinc-200">
                            Browser Sign-In Flow
                          </span>
                          <span className="text-[11px] font-mono text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                            Zero API Cost
                          </span>
                        </div>
                        <p className="text-xs text-zinc-400 leading-relaxed">
                          Sign in with your {selectedProvider === "codex" ? "OpenAI ChatGPT (Plus/Pro)" : "Anthropic Claude"} subscription directly in your browser. We handle token exchange and inject credentials automatically into your workers.
                        </p>
                        <button
                          type="button"
                          onClick={handleStartSignIn}
                          disabled={isStartingFlow}
                          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-zinc-100 hover:bg-white text-zinc-900 text-xs font-semibold cursor-pointer transition-colors shadow-xs disabled:opacity-50"
                        >
                          {isStartingFlow ? (
                            <>
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              <span>Initiating sign-in...</span>
                            </>
                          ) : (
                            <>
                              <ExternalLink className="h-3.5 w-3.5" />
                              <span>Sign in with {selectedProvider === "codex" ? "ChatGPT" : "Claude"}</span>
                            </>
                          )}
                        </button>
                      </div>
                    ) : (
                      /* Active Flow Progress Card */
                      <div className="rounded-xl border border-emerald-500/40 bg-zinc-900/90 p-4 space-y-3 shadow-lg">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <Loader2 className="h-4 w-4 text-emerald-400 animate-spin" />
                            <span className="text-xs font-semibold text-zinc-200">
                              {activeFlow.phase === "waiting_for_user" ? "Waiting for authorization" : "Connecting..."}
                            </span>
                          </div>
                          <button
                            type="button"
                            onClick={handleCancelFlow}
                            className="text-[11px] text-zinc-400 hover:text-zinc-200 cursor-pointer"
                          >
                            Cancel
                          </button>
                        </div>

                        {activeFlow.userCode && (
                          <div className="p-3 bg-black/60 rounded-lg border border-zinc-800 space-y-2">
                            <div className="flex items-center justify-between">
                              <span className="text-[11px] font-medium text-zinc-400">One-time confirmation code</span>
                              <button
                                type="button"
                                onClick={() => handleCopyCode(activeFlow.userCode!)}
                                className="flex items-center gap-1 text-[11px] text-emerald-400 hover:text-emerald-300 cursor-pointer"
                              >
                                {copiedCode ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                                <span>{copiedCode ? "Copied" : "Copy code"}</span>
                              </button>
                            </div>
                            <div className="text-center font-mono text-xl tracking-widest text-emerald-300 font-bold py-1 bg-zinc-900/80 rounded border border-emerald-500/20">
                              {activeFlow.userCode}
                            </div>
                          </div>
                        )}

                        {activeFlow.authorizationUrl && (
                          <div className="flex items-center gap-2">
                            <a
                              href={activeFlow.authorizationUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="flex-1 flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium transition-colors cursor-pointer shadow-xs"
                            >
                              <span>Open Authorization Page</span>
                              <ExternalLink className="h-3.5 w-3.5" />
                            </a>
                          </div>
                        )}

                        <p className="text-[11px] text-zinc-400 text-center">
                          Approve in your browser. Once complete, you will advance to Step 4 automatically.
                        </p>
                      </div>
                    )}

                    {/* 3. Collapsible Manual Paste Fallback */}
                    <div className="pt-2 border-t border-zinc-800/60">
                      <button
                        type="button"
                        onClick={() => setShowManualPaste(!showManualPaste)}
                        className="flex items-center justify-between w-full text-xs text-zinc-400 hover:text-zinc-200 transition-colors py-1 cursor-pointer"
                      >
                        <span>Or paste session token / JSON manually</span>
                        {showManualPaste ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                      </button>

                      {showManualPaste && (
                        <div className="mt-3 space-y-3">
                          <div className="flex items-center justify-between mb-1.5">
                            <label htmlFor="auth-json-input" className="text-xs font-medium text-zinc-300">
                              {selectedProvider === "codex" ? "Session JSON (~/.codex/auth.json)" : "Setup Token or ~/.claude.json"}
                            </label>
                            <span className="text-[11px] font-mono text-zinc-500">
                              {selectedProvider === "codex" ? "JSON" : "sk-ant-oat01-... or JSON"}
                            </span>
                          </div>
                          <textarea
                            id="auth-json-input"
                            rows={3}
                            value={credentialValue}
                            onChange={(e) => setCredentialValue(e.target.value)}
                            placeholder={
                              selectedProvider === "codex"
                                ? "Paste contents of ~/.codex/auth.json..."
                                : "Paste sk-ant-oat01-... token or ~/.claude.json..."
                            }
                            className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs font-mono text-zinc-200 placeholder-zinc-500 focus:border-emerald-500 focus:outline-hidden resize-none leading-relaxed"
                          />
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3 pt-2">
                    <div className="flex items-center justify-between">
                      <label htmlFor="api-key-input" className="block text-xs font-medium text-zinc-300">
                        {selectedProvider === "codex" ? "OpenAI API Key" : "Anthropic API Key"}
                      </label>
                      <a
                        href={
                          selectedProvider === "codex"
                            ? "https://platform.openai.com/api-keys"
                            : "https://console.anthropic.com/settings/keys"
                        }
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-[11px] text-emerald-400 hover:text-emerald-300 transition-colors"
                      >
                        <span>Get key</span>
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    </div>
                    <input
                      id="api-key-input"
                      type="password"
                      value={credentialValue}
                      onChange={(e) => setCredentialValue(e.target.value)}
                      placeholder={selectedProvider === "codex" ? "sk-proj-..." : "sk-ant-api03-..."}
                      className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs font-mono text-zinc-200 placeholder-zinc-500 focus:border-emerald-500 focus:outline-hidden"
                    />
                    <p className="text-[11px] text-zinc-500">
                      Standard usage-based API key from the {selectedProvider === "codex" ? "OpenAI Platform" : "Anthropic Console"}.
                    </p>
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between pt-4 border-t border-zinc-900">
                <button
                  type="button"
                  onClick={() => goToStep(2)}
                  className="rounded-lg px-4 py-2 text-xs font-medium text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900 transition-colors cursor-pointer"
                >
                  Back
                </button>

                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => goToStep(4)}
                    className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
                  >
                    Configure credentials later
                  </button>
                  <button
                    type="submit"
                    disabled={savingCredentials || !credentialValue.trim()}
                    className="flex items-center gap-2 rounded-lg bg-emerald-600 px-5 py-2.5 text-xs font-medium text-white transition-colors hover:bg-emerald-500 cursor-pointer disabled:opacity-50 shadow-xs"
                  >
                    {savingCredentials ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        <span>Encrypting and saving...</span>
                      </>
                    ) : (
                      <>
                        <span>Save and continue</span>
                        <ChevronRight className="h-3.5 w-3.5" />
                      </>
                    )}
                  </button>
                </div>
              </div>
            </form>
          </div>
        )}

        {/* Step 4: First Sample Task */}
        {currentStep === 4 && (
          <div className="space-y-6">
            <div className="space-y-2">
              <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">
                Launch your first coding agent task
              </h1>
              <p className="text-sm text-zinc-400 max-w-2xl leading-relaxed">
                Confirm your task details below. Cloud Worker will provision an isolated microVM, initialize the repository, and start streaming live execution.
              </p>
            </div>

            <form onSubmit={handleLaunchSampleTask} className="space-y-5">
              {taskError && (
                <div className="flex items-center gap-2 rounded-lg border border-rose-900/60 bg-rose-950/40 p-3 text-xs text-rose-300">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span>{taskError}</span>
                </div>
              )}

              <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-6 space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="sample-owner-input" className="block text-xs font-medium text-zinc-300 mb-1">
                      GitHub owner
                    </label>
                    <input
                      id="sample-owner-input"
                      type="text"
                      value={taskOwner}
                      onChange={(e) => setTaskOwner(e.target.value)}
                      placeholder="octocat"
                      required
                      className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-zinc-100 placeholder-zinc-500 focus:border-emerald-500 focus:outline-hidden"
                    />
                  </div>

                  <div>
                    <label htmlFor="sample-repo-input" className="block text-xs font-medium text-zinc-300 mb-1">
                      Repository name
                    </label>
                    <input
                      id="sample-repo-input"
                      type="text"
                      value={taskRepo}
                      onChange={(e) => setTaskRepo(e.target.value)}
                      placeholder="Hello-World"
                      required
                      className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-zinc-100 placeholder-zinc-500 focus:border-emerald-500 focus:outline-hidden"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="sample-branch-input" className="block text-xs font-medium text-zinc-300 mb-1">
                      Target branch
                    </label>
                    <input
                      id="sample-branch-input"
                      type="text"
                      value={taskBranch}
                      onChange={(e) => setTaskBranch(e.target.value)}
                      placeholder="main"
                      className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-zinc-100 placeholder-zinc-500 focus:border-emerald-500 focus:outline-hidden"
                    />
                  </div>

                  <div>
                    <label htmlFor="sample-model-select" className="block text-xs font-medium text-zinc-300 mb-1">
                      Agent model & harness
                    </label>
                    <select
                      id="sample-model-select"
                      value={taskModel}
                      onChange={(e) => handleModelChange(e.target.value)}
                      className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-zinc-100 focus:border-emerald-500 focus:outline-hidden"
                    >
                      <optgroup label="OpenAI Codex">
                        {codexModels.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name} {m.badge ? `• ${m.badge}` : ""}
                          </option>
                        ))}
                      </optgroup>
                      <optgroup label="Claude Code">
                        {claudeModels.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name} {m.badge ? `• ${m.badge}` : ""}
                          </option>
                        ))}
                      </optgroup>
                    </select>
                  </div>
                </div>

                {/* Model description & reasoning effort if supported */}
                {selectedModelObj && (
                  <div className="space-y-3 rounded-lg border border-zinc-800/80 bg-zinc-900/40 p-3">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-zinc-400 font-medium">Model description</span>
                      {selectedModelObj.badge && (
                        <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                          {selectedModelObj.badge}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-zinc-400 leading-relaxed">
                      {selectedModelObj.description}
                    </p>

                    {selectedModelObj.supportsReasoning && (
                      <div className="pt-2 border-t border-zinc-800/60 space-y-2">
                        <div className="flex items-center justify-between">
                          <label className="text-xs font-medium text-zinc-300 flex items-center gap-1.5">
                            <BrainCircuit className="w-3.5 h-3.5 text-emerald-400" />
                            Reasoning effort / Extended thinking
                          </label>
                          <span className="text-[11px] font-mono text-emerald-400 capitalize">
                            {taskReasoningEffort}
                          </span>
                        </div>

                        <div className="grid grid-cols-4 gap-1.5">
                          {(["none", "low", "medium", "high"] as const).map((effort) => (
                            <button
                              key={effort}
                              type="button"
                              onClick={() => setTaskReasoningEffort(effort)}
                              className={`py-1.5 px-2 rounded-md text-xs font-medium capitalize transition-colors cursor-pointer border ${
                                taskReasoningEffort === effort
                                  ? "bg-emerald-600/20 border-emerald-500/50 text-emerald-300"
                                  : "bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800"
                              }`}
                            >
                              {effort}
                            </button>
                          ))}
                        </div>

                        <p className="text-[10px] text-zinc-500">
                          {taskReasoningEffort === "none" && "No extra reasoning pass; immediate code edits."}
                          {taskReasoningEffort === "low" && "Fast reasoning pass for direct fixes."}
                          {taskReasoningEffort === "medium" && "Balanced reasoning for bugs, tests, and refactoring."}
                          {taskReasoningEffort === "high" && "Deep multi-step reasoning for intricate architectures."}
                        </p>
                      </div>
                    )}
                  </div>
                )}

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label htmlFor="sample-prompt-input" className="text-xs font-medium text-zinc-300">
                      Instruction prompt
                    </label>
                    <span className="text-[11px] text-zinc-500 font-mono">
                      {taskPrompt.length} chars
                    </span>
                  </div>
                  <textarea
                    id="sample-prompt-input"
                    rows={3}
                    value={taskPrompt}
                    onChange={(e) => setTaskPrompt(e.target.value)}
                    required
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-zinc-100 placeholder-zinc-500 focus:border-emerald-500 focus:outline-hidden resize-none leading-relaxed"
                  />
                </div>

                {/* Prompt Presets */}
                <div className="space-y-1.5 pt-1">
                  <span className="text-[11px] font-medium text-zinc-500">
                    Sample suggestions:
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {SAMPLE_PROMPTS.map((p, idx) => (
                      <button
                        key={idx}
                        type="button"
                        onClick={() => setTaskPrompt(p)}
                        className="text-left text-[11px] px-2.5 py-1 rounded bg-zinc-900 hover:bg-zinc-800 border border-zinc-800/80 text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer"
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between pt-4 border-t border-zinc-900">
                <button
                  type="button"
                  onClick={() => goToStep(3)}
                  className="rounded-lg px-4 py-2 text-xs font-medium text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900 transition-colors cursor-pointer"
                >
                  Back
                </button>

                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={handleSkipToDashboard}
                    className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
                  >
                    Skip sample task and enter dashboard
                  </button>

                  <button
                    type="submit"
                    disabled={launchingTask || !taskOwner.trim() || !taskRepo.trim() || !taskPrompt.trim()}
                    className="flex items-center gap-2 rounded-lg bg-emerald-600 px-5 py-2.5 text-xs font-medium text-white transition-colors hover:bg-emerald-500 cursor-pointer disabled:opacity-50 shadow-xs"
                  >
                    {launchingTask ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        <span>Provisioning VM sandbox...</span>
                      </>
                    ) : (
                      <>
                        <Sparkles className="h-3.5 w-3.5" />
                        <span>Launch task and enter dashboard</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            </form>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-zinc-900 px-6 py-4 text-center text-xs text-zinc-600">
        Cloud Worker. Autonomous agent control plane and in-microVM subscription harness.
      </footer>
    </div>
  );
}
