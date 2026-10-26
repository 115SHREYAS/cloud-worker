"use client";

import { useState, useEffect, useRef } from "react";
import type { UserPublicProfile } from "@cloud-worker/shared";
import {
  fetchAuthStatus,
  saveUserCredentials,
  saveAuthSession,
  detectLocalProviderCredentials,
  importLocalProviderCredentials,
  startProviderLoginFlow,
  fetchProviderFlowStatus,
  cancelProviderLoginFlow,
  type DetectedProviderAuth,
  type ProviderAuthFlow,
} from "../lib/api";
import {
  X,
  KeyRound,
  Check,
  AlertCircle,
  Loader2,
  Copy,
  ExternalLink,
  Sparkles,
  LogOut,
  User,
  Cpu,
  Globe,
  Terminal,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

type Provider = "codex" | "claude";
type SettingsTab = "account" | "inference";

interface StatusInfo {
  configured: boolean;
  authMode?: "subscription" | "api_key";
}

const PROVIDER_META: Record<
  Provider,
  {
    name: string;
    tagline: string;
    subscriptionLabel: string;
    signInLabel: string;
    keyLabel: string;
    keyPlaceholder: string;
    keyUrl: string;
    keyHint: string;
    manualLabel: string;
    manualPlaceholder: string;
  }
> = {
  codex: {
    name: "OpenAI Codex",
    tagline: "Runs the Codex CLI harness in your microVM sandbox.",
    subscriptionLabel: "ChatGPT subscription",
    signInLabel: "Sign in with ChatGPT",
    keyLabel: "OpenAI API key",
    keyPlaceholder: "sk-proj-...",
    keyUrl: "https://platform.openai.com/api-keys",
    keyHint: "Metered per-token usage from the OpenAI Platform instead of your plan quota.",
    manualLabel: "Session JSON (~/.codex/auth.json)",
    manualPlaceholder: "Paste ~/.codex/auth.json content...",
  },
  claude: {
    name: "Claude Code",
    tagline: "Runs the Claude Code CLI harness in your microVM sandbox.",
    subscriptionLabel: "Claude subscription",
    signInLabel: "Sign in with Claude",
    keyLabel: "Anthropic API key",
    keyPlaceholder: "sk-ant-api03-...",
    keyUrl: "https://console.anthropic.com/settings/keys",
    keyHint: "Metered per-token usage from the Anthropic Console instead of your plan quota.",
    manualLabel: "Setup token or ~/.claude.json",
    manualPlaceholder: "Paste sk-ant-oat01-... or ~/.claude.json content...",
  },
};

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentUser: UserPublicProfile | null;
  onSignOut: () => Promise<void>;
}

export function SettingsModal({ isOpen, onClose, currentUser, onSignOut }: SettingsModalProps) {
  const [tab, setTab] = useState<SettingsTab>("account");
  const [statuses, setStatuses] = useState<Record<Provider, StatusInfo | null>>({
    codex: null,
    claude: null,
  });
  const [detectedAuths, setDetectedAuths] = useState<DetectedProviderAuth[]>([]);
  const [connectingProvider, setConnectingProvider] = useState<Provider | null>(null);
  const [activeFlow, setActiveFlow] = useState<ProviderAuthFlow | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [manualCred, setManualCred] = useState("");
  const [showManualPaste, setShowManualPaste] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshStatus = async () => {
    const [codex, claude, detected] = await Promise.all([
      fetchAuthStatus("codex").catch((): StatusInfo => ({ configured: false })),
      fetchAuthStatus("claude").catch((): StatusInfo => ({ configured: false })),
      detectLocalProviderCredentials().catch(() => []),
    ]);
    setStatuses({
      codex: { configured: codex.configured, authMode: codex.authMode },
      claude: { configured: claude.configured, authMode: claude.authMode },
    });
    setDetectedAuths(detected);
  };

  useEffect(() => {
    if (!isOpen) return;

    let ignore = false;
    setTab("account");
    setSuccessMsg(null);
    setErrorMsg(null);
    setConnectingProvider(null);
    setActiveFlow(null);
    setApiKey("");
    setManualCred("");
    setShowManualPaste(false);

    refreshStatus().catch(() => {
      if (!ignore) {
        setStatuses({
          codex: { configured: false },
          claude: { configured: false },
        });
      }
    });

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      ignore = true;
      window.removeEventListener("keydown", handleKeyDown);
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [isOpen, onClose]);

  // Poll the active provider login flow until it settles.
  useEffect(() => {
    if (!activeFlow || activeFlow.phase === "succeeded" || activeFlow.phase === "failed" || activeFlow.phase === "cancelled") {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      return;
    }

    const flowId = activeFlow.id;
    pollIntervalRef.current = setInterval(async () => {
      try {
        const { flow } = await fetchProviderFlowStatus(flowId);
        setActiveFlow(flow);

        if (flow.phase === "succeeded") {
          setSuccessMsg(flow.message || `Connected to ${PROVIDER_META[flow.provider].name}.`);
          setActiveFlow(null);
          setConnectingProvider(null);
          refreshStatus().catch(() => {});
        } else if (flow.phase === "failed") {
          setErrorMsg(flow.error || "Authentication failed or timed out.");
          setActiveFlow(null);
        }
      } catch {
        // Ignore transient polling errors
      }
    }, 2000);

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [activeFlow]);

  if (!isOpen) return null;

  const handleCopy = (text: string, isCode = false) => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(text);
      if (isCode) {
        setCopiedCode(true);
        setTimeout(() => setCopiedCode(false), 2000);
      }
    }
  };

  const openConnectPanel = (prov: Provider) => {
    setErrorMsg(null);
    setSuccessMsg(null);
    setConnectingProvider(prov);
    setShowManualPaste(false);
    setApiKey("");
    setManualCred("");
  };

  const handleStartSignIn = async (prov: Provider) => {
    setErrorMsg(null);
    setIsBusy(true);
    try {
      const { flow } = await startProviderLoginFlow(prov);
      setActiveFlow(flow);
      if (flow.authorizationUrl && typeof window !== "undefined") {
        window.open(flow.authorizationUrl, "_blank", "noopener,noreferrer");
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setIsBusy(false);
    }
  };

  const handleCancelFlow = async () => {
    if (!activeFlow) return;
    try {
      await cancelProviderLoginFlow(activeFlow.id);
    } catch {
      // Flow cleanup is best-effort
    }
    setActiveFlow(null);
  };

  const handleImportLocal = async (prov: Provider) => {
    setErrorMsg(null);
    setIsBusy(true);
    try {
      await importLocalProviderCredentials(prov);
      setSuccessMsg(`Connected ${PROVIDER_META[prov].name} from your local CLI session.`);
      setConnectingProvider(null);
      await refreshStatus();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setIsBusy(false);
    }
  };

  const saveCredential = async (prov: Provider, authMode: "subscription" | "api_key", credential: string) => {
    try {
      await saveUserCredentials({ provider: prov, authMode, credential });
    } catch {
      if (authMode !== "subscription") throw new Error("Failed to save credentials");
      await saveAuthSession(prov, credential);
    }
  };

  const handleSaveApiKey = async (prov: Provider) => {
    const trimmed = apiKey.trim();
    if (!trimmed) return;
    setErrorMsg(null);
    setIsBusy(true);
    try {
      await saveCredential(prov, "api_key", trimmed);
      setSuccessMsg(`Connected ${PROVIDER_META[prov].name} via API key.`);
      setConnectingProvider(null);
      setApiKey("");
      await refreshStatus();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setIsBusy(false);
    }
  };

  const handleSaveManual = async (prov: Provider) => {
    const trimmed = manualCred.trim();
    if (!trimmed) return;
    setErrorMsg(null);
    setIsBusy(true);
    try {
      await saveCredential(prov, "subscription", trimmed);
      setSuccessMsg(`Connected ${PROVIDER_META[prov].name} via pasted credentials.`);
      setConnectingProvider(null);
      setManualCred("");
      await refreshStatus();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setIsBusy(false);
    }
  };

  const handleSignOutClick = async () => {
    setIsSigningOut(true);
    try {
      await onSignOut();
    } finally {
      setIsSigningOut(false);
    }
  };

  const statusChip = (prov: Provider) => {
    const status = statuses[prov];
    if (!status) {
      return (
        <span className="flex items-center gap-1.5 text-[11px] font-mono text-zinc-500">
          <Loader2 className="w-3 h-3 animate-spin" /> Checking...
        </span>
      );
    }
    if (status.configured) {
      return (
        <span className="flex items-center gap-1.5 text-[11px] font-mono font-medium text-emerald-400">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          Connected · {status.authMode === "api_key" ? "API key" : "Subscription"}
        </span>
      );
    }
    return (
      <span className="flex items-center gap-1.5 text-[11px] font-mono text-zinc-500">
        <span className="h-1.5 w-1.5 rounded-full bg-zinc-600" />
        Not connected
      </span>
    );
  };

  const renderConnectPanel = (prov: Provider) => {
    const meta = PROVIDER_META[prov];
    const detected = detectedAuths.find((d) => d.provider === prov && d.available && d.hasToken);

    return (
      <div className="mt-3 rounded-xl border border-zinc-800 bg-zinc-950/80 p-4 space-y-4">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-zinc-200">Connect {meta.name}</span>
          <button
            type="button"
            onClick={() => {
              setConnectingProvider(null);
              setActiveFlow(null);
              setErrorMsg(null);
            }}
            className="text-[11px] text-zinc-400 hover:text-zinc-200 cursor-pointer"
          >
            Cancel
          </button>
        </div>

        {/* Method 1: subscription browser sign-in */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 space-y-2.5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2.5 min-w-0">
              <span className="mt-0.5 flex items-center justify-center w-6 h-6 rounded-md bg-blue-500/10 text-blue-400 border border-blue-500/20 shrink-0">
                <Globe className="w-3 h-3" />
              </span>
              <div className="min-w-0">
                <p className="text-xs font-medium text-zinc-200">{meta.subscriptionLabel}</p>
                <p className="text-[11px] text-zinc-400 leading-relaxed mt-0.5">
                  Authorize in your browser. Tasks run on your plan&apos;s monthly quota.
                </p>
              </div>
            </div>
          </div>

          {!activeFlow ? (
            <button
              type="button"
              onClick={() => handleStartSignIn(prov)}
              disabled={isBusy}
              className="flex items-center gap-2 px-3.5 py-2 rounded-lg bg-zinc-100 hover:bg-white text-zinc-900 text-xs font-semibold cursor-pointer transition-colors shadow-xs disabled:opacity-50"
            >
              {isBusy ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Initiating sign-in...</span>
                </>
              ) : (
                <>
                  <ExternalLink className="w-3.5 h-3.5" />
                  <span>{meta.signInLabel}</span>
                </>
              )}
            </button>
          ) : activeFlow.provider === prov ? (
            <div className="rounded-lg border border-blue-500/40 bg-zinc-900/90 p-3 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin" />
                  <span className="text-xs font-medium text-zinc-200">
                    {activeFlow.phase === "waiting_for_user" ? "Awaiting authorization" : "Connecting..."}
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
                <div className="p-2.5 bg-black/60 rounded-lg border border-zinc-800 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-medium text-zinc-400">One-time confirmation code</span>
                    <button
                      type="button"
                      onClick={() => handleCopy(activeFlow.userCode!, true)}
                      className="flex items-center gap-1 text-[11px] text-blue-400 hover:text-blue-300 cursor-pointer"
                    >
                      {copiedCode ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                      <span>{copiedCode ? "Copied" : "Copy code"}</span>
                    </button>
                  </div>
                  <div className="text-center font-mono text-lg tracking-widest text-blue-300 font-bold py-1 bg-zinc-900/80 rounded border border-blue-500/20">
                    {activeFlow.userCode}
                  </div>
                </div>
              )}

              {activeFlow.authorizationUrl && (
                <a
                  href={activeFlow.authorizationUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center justify-center gap-1.5 w-full py-2 px-3 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium transition-colors cursor-pointer shadow-xs"
                >
                  <span>Open Authorization Page</span>
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              )}

              <p className="text-[11px] text-zinc-400 text-center">
                Keep this open. Once approved in your browser, the connection completes automatically.
              </p>
            </div>
          ) : null}
        </div>

        {/* Method 2: detected local CLI session */}
        {detected && (
          <div className="rounded-lg border border-blue-500/30 bg-blue-950/20 p-3 space-y-2.5">
            <div className="flex items-start gap-2.5">
              <span className="mt-0.5 flex items-center justify-center w-6 h-6 rounded-md bg-blue-500/10 text-blue-400 border border-blue-500/20 shrink-0">
                <Sparkles className="w-3 h-3" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-xs font-medium text-blue-200">{detected.planName || "Local session"} detected</p>
                  <span className="text-[10px] font-mono text-blue-400/80 bg-blue-500/10 px-1.5 py-0.5 rounded border border-blue-500/20">
                    {detected.source}
                  </span>
                </div>
                <p className="text-[11px] text-zinc-300 leading-relaxed mt-0.5">
                  An active {meta.subscriptionLabel} session{detected.email ? ` (${detected.email})` : ""} was found on this
                  machine. Connect with one click.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => handleImportLocal(prov)}
              disabled={isBusy}
              className="flex items-center gap-2 px-3.5 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium cursor-pointer transition-colors shadow-xs disabled:opacity-50"
            >
              {isBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
              <span>Import local session</span>
            </button>
          </div>
        )}

        {/* Method 3: API key */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 space-y-2.5">
          <div className="flex items-start gap-2.5">
            <span className="mt-0.5 flex items-center justify-center w-6 h-6 rounded-md bg-zinc-500/10 text-zinc-400 border border-zinc-500/20 shrink-0">
              <KeyRound className="w-3 h-3" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-zinc-200">API key</p>
              <p className="text-[11px] text-zinc-400 leading-relaxed mt-0.5">{meta.keyHint}</p>
            </div>
            <a
              href={meta.keyUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-[11px] text-blue-400 hover:text-blue-300 transition-colors shrink-0"
            >
              <span>Get key</span>
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>
          <div className="flex gap-2">
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={meta.keyPlaceholder}
              autoComplete="off"
              className="flex-1 px-3 py-2 text-xs font-mono bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-200 placeholder-zinc-500 focus:outline-hidden focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors"
            />
            <button
              type="button"
              onClick={() => handleSaveApiKey(prov)}
              disabled={isBusy || !apiKey.trim()}
              className="px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium cursor-pointer transition-colors disabled:opacity-50"
            >
              {isBusy ? "Saving..." : "Save"}
            </button>
          </div>
        </div>

        {/* Method 4: manual paste fallback */}
        <div className="pt-1 border-t border-zinc-800/60">
          <button
            type="button"
            onClick={() => setShowManualPaste(!showManualPaste)}
            className="flex items-center justify-between w-full text-xs text-zinc-400 hover:text-zinc-200 transition-colors py-1 cursor-pointer"
          >
            <span>Or paste session credentials manually</span>
            {showManualPaste ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>

          {showManualPaste && (
            <div className="mt-3 space-y-2.5">
              <label className="block text-xs font-medium text-zinc-300">{meta.manualLabel}</label>
              <textarea
                rows={3}
                value={manualCred}
                onChange={(e) => setManualCred(e.target.value)}
                placeholder={meta.manualPlaceholder}
                className="w-full px-3 py-2 text-xs font-mono bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-200 placeholder-zinc-500 focus:outline-hidden focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-colors resize-none leading-relaxed"
              />
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => handleSaveManual(prov)}
                  disabled={isBusy || !manualCred.trim()}
                  className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium cursor-pointer transition-colors disabled:opacity-50"
                >
                  {isBusy ? "Saving..." : "Save credentials"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  const providerRow = (prov: Provider) => {
    const meta = PROVIDER_META[prov];
    const status = statuses[prov];
    const isConnected = status?.configured === true;

    return (
      <div key={prov} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-zinc-800 text-zinc-300 border border-zinc-700/60 shrink-0">
              <Terminal className="w-4 h-4" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-zinc-100 truncate">{meta.name}</p>
              <p className="text-[11px] text-zinc-400 truncate">{meta.tagline}</p>
            </div>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {statusChip(prov)}
            <button
              type="button"
              onClick={() => (connectingProvider === prov ? setConnectingProvider(null) : openConnectPanel(prov))}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-colors ${
                isConnected
                  ? "text-zinc-300 hover:text-zinc-100 border border-zinc-800 hover:border-zinc-700 hover:bg-zinc-900"
                  : "bg-emerald-600 hover:bg-emerald-500 text-white shadow-xs"
              }`}
            >
              {isConnected ? "Update" : "Connect"}
            </button>
          </div>
        </div>

        {connectingProvider === prov && renderConnectPanel(prov)}
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-xs">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-modal-title"
        className="w-full max-w-3xl max-h-[92vh] flex bg-zinc-950 border border-zinc-800 rounded-xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150"
      >
        {/* Tab rail */}
        <aside className="w-44 shrink-0 border-r border-zinc-800 bg-zinc-900/40 flex flex-col">
          <div className="flex items-center justify-between px-4 py-4 border-b border-zinc-800">
            <div className="flex items-center gap-2">
              <span className="flex items-center justify-center w-7 h-7 rounded-lg bg-blue-500/10 text-blue-400 border border-blue-500/20">
                <KeyRound className="w-4 h-4" />
              </span>
              <h2 id="settings-modal-title" className="text-sm font-semibold text-zinc-100">
                Settings
              </h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close settings"
              className="p-1 rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <nav className="p-2 space-y-1">
            <button
              type="button"
              onClick={() => setTab("account")}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
                tab === "account"
                  ? "bg-zinc-800 text-zinc-100"
                  : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900"
              }`}
            >
              <User className="w-3.5 h-3.5" />
              <span>Account</span>
            </button>
            <button
              type="button"
              onClick={() => setTab("inference")}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
                tab === "inference"
                  ? "bg-zinc-800 text-zinc-100"
                  : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900"
              }`}
            >
              <Cpu className="w-3.5 h-3.5" />
              <span>Inference</span>
            </button>
          </nav>
        </aside>

        {/* Content */}
        <div className="flex-1 overflow-y-auto max-h-[92vh]">
          {tab === "account" ? (
            <div className="p-5 sm:p-6 space-y-4">
              <div>
                <h3 className="text-sm font-semibold text-zinc-100">Account</h3>
                <p className="text-xs text-zinc-400 mt-0.5">Your Cloud Worker profile and session.</p>
              </div>

              {currentUser && (
                <div className="flex items-center gap-3 p-4 rounded-xl border border-zinc-800 bg-zinc-900/40">
                  {currentUser.avatarUrl ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img
                      src={currentUser.avatarUrl}
                      alt={currentUser.username}
                      className="w-10 h-10 rounded-full border border-zinc-800 object-cover shrink-0"
                    />
                  ) : (
                    <div className="w-10 h-10 rounded-full bg-blue-500/20 text-blue-400 border border-blue-500/30 flex items-center justify-center text-sm font-bold shrink-0">
                      {currentUser.username[0]?.toUpperCase() || "U"}
                    </div>
                  )}
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-zinc-100 truncate font-mono">{currentUser.username}</p>
                    <p className="text-xs text-zinc-400 truncate">{currentUser.email}</p>
                  </div>
                </div>
              )}

              <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
                <p className="text-xs font-medium text-zinc-200">Session</p>
                <p className="text-[11px] text-zinc-400 mt-0.5 leading-relaxed">
                  Signing out ends this browser session. Your connected providers and tasks stay intact.
                </p>
                <button
                  type="button"
                  onClick={handleSignOutClick}
                  disabled={isSigningOut}
                  className="mt-3 flex items-center gap-2 px-3.5 py-2 rounded-lg border border-rose-500/30 bg-rose-950/40 hover:bg-rose-900/40 text-rose-300 text-xs font-medium cursor-pointer transition-colors disabled:opacity-50"
                >
                  {isSigningOut ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <LogOut className="w-3.5 h-3.5" />}
                  <span>{isSigningOut ? "Signing out..." : "Sign out"}</span>
                </button>
              </div>
            </div>
          ) : (
            <div className="p-5 sm:p-6 space-y-4">
              <div>
                <h3 className="text-sm font-semibold text-zinc-100">Inference</h3>
                <p className="text-xs text-zinc-400 mt-0.5 leading-relaxed">
                  Connect the agent harnesses that run inside your sandboxes. Credentials are encrypted with AES-256-GCM
                  and injected into microVMs at task start.
                </p>
              </div>

              {successMsg && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-blue-950/40 border border-blue-900/60 text-blue-300 text-xs">
                  <Check className="w-4 h-4 shrink-0" />
                  <span>{successMsg}</span>
                </div>
              )}

              {errorMsg && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-rose-950/40 border border-rose-900/60 text-rose-300 text-xs">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{errorMsg}</span>
                </div>
              )}

              <div className="space-y-3">{providerRow("codex")}{providerRow("claude")}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
