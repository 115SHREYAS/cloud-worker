"use client";

import { useState, useEffect, useRef } from "react";
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
  ChevronDown,
  ChevronUp,
} from "lucide-react";

interface AuthSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function AuthSettingsModal({ isOpen, onClose }: AuthSettingsModalProps) {
  const [provider, setProvider] = useState<"codex" | "claude">("codex");
  const [authMode, setAuthMode] = useState<"subscription" | "api_key">("subscription");
  const [credential, setCredential] = useState("");
  const [codexConfigured, setCodexConfigured] = useState<boolean | null>(null);
  const [claudeConfigured, setClaudeConfigured] = useState<boolean | null>(null);
  const [detectedAuths, setDetectedAuths] = useState<DetectedProviderAuth[]>([]);
  const [isImporting, setIsImporting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isStartingFlow, setIsStartingFlow] = useState(false);
  const [activeFlow, setActiveFlow] = useState<ProviderAuthFlow | null>(null);
  const [showManualPaste, setShowManualPaste] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);
  const [copiedCommand, setCopiedCommand] = useState(false);

  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const handleCopy = (text: string, isCode = false) => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(text);
      if (isCode) {
        setCopiedCode(true);
        setTimeout(() => setCopiedCode(false), 2000);
      } else {
        setCopiedCommand(true);
        setTimeout(() => setCopiedCommand(false), 2000);
      }
    }
  };

  const refreshStatus = async () => {
    try {
      const [codex, claude, detected] = await Promise.all([
        fetchAuthStatus("codex").catch(() => ({ configured: false })),
        fetchAuthStatus("claude").catch(() => ({ configured: false })),
        detectLocalProviderCredentials().catch(() => []),
      ]);
      setCodexConfigured(codex.configured);
      setClaudeConfigured(claude.configured);
      setDetectedAuths(detected);
    } catch {
      // Ignore background refresh errors
    }
  };

  useEffect(() => {
    if (!isOpen) return;

    refreshStatus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, [isOpen, onClose]);

  // Polling effect for active login flow
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
          setSuccessMsg(flow.message || "Successfully authenticated!");
          refreshStatus();
          if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = null;
          }
        } else if (flow.phase === "failed") {
          setErrorMsg(flow.error || "Authentication failed or timed out.");
          if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = null;
          }
        }
      } catch {
        // Ignore polling errors
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

  // 1-Click Import of detected local credentials
  const handleImportLocal = async (prov: "codex" | "claude") => {
    setErrorMsg(null);
    setSuccessMsg(null);
    setIsImporting(true);

    try {
      await importLocalProviderCredentials(prov);
      setSuccessMsg(`Successfully connected ${prov === "codex" ? "OpenAI Codex" : "Claude Code"} from local CLI session!`);
      await refreshStatus();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setIsImporting(false);
    }
  };

  // Start interactive sign-in flow
  const handleStartSignIn = async () => {
    setErrorMsg(null);
    setSuccessMsg(null);
    setIsStartingFlow(true);

    try {
      const { flow } = await startProviderLoginFlow(provider);
      setActiveFlow(flow);
      if (flow.authorizationUrl && typeof window !== "undefined") {
        window.open(flow.authorizationUrl, "_blank", "noopener,noreferrer");
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setIsStartingFlow(false);
    }
  };

  // Cancel sign-in flow
  const handleCancelFlow = async () => {
    if (!activeFlow) return;
    try {
      await cancelProviderLoginFlow(activeFlow.id);
      setActiveFlow(null);
    } catch {
      setActiveFlow(null);
    }
  };

  // Manual save
  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setSuccessMsg(null);

    const trimmed = credential.trim();
    if (!trimmed) {
      setErrorMsg("Please enter valid credentials.");
      return;
    }

    setIsSaving(true);
    try {
      try {
        await saveUserCredentials({
          provider,
          authMode,
          credential: trimmed,
        });
      } catch {
        await saveAuthSession(provider, trimmed);
      }

      setSuccessMsg(`Saved credentials for ${provider === "codex" ? "OpenAI Codex" : "Claude Code"}.`);
      setCredential("");
      await refreshStatus();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSaving(false);
    }
  };

  const currentDetected = detectedAuths.find((d) => d.provider === provider);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-xs">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-modal-title"
        className="w-full max-w-xl max-h-[92vh] flex flex-col bg-zinc-950 border border-zinc-800 rounded-xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 sm:px-6 py-3.5 sm:py-4 border-b border-zinc-800 bg-zinc-900/60 shrink-0">
          <div className="flex items-center gap-2.5">
            <span className="flex items-center justify-center w-7 h-7 rounded-lg bg-blue-500/10 text-blue-400 border border-blue-500/20">
              <KeyRound className="w-4 h-4" />
            </span>
            <div>
              <h2 id="auth-modal-title" className="text-sm sm:text-base font-semibold text-zinc-100">
                Agent credentials
              </h2>
              <p className="text-[11px] sm:text-xs text-zinc-400 mt-0.5">
                Encrypted with AES-256-GCM and injected into microVMs during task execution.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content Body */}
        <div className="overflow-y-auto flex-1">
          {/* Status Indicators */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-4 sm:p-6 pb-2">
            <div className="p-3 rounded-lg border border-zinc-800 bg-zinc-900/40">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold text-zinc-200">OpenAI Codex</span>
                {codexConfigured ? (
                  <span className="flex items-center gap-1 text-[11px] font-mono text-blue-400">
                    <Check className="w-3 h-3" /> Ready
                  </span>
                ) : (
                  <span className="text-[11px] font-mono text-zinc-500">Not set</span>
                )}
              </div>
              <p className="text-[11px] text-zinc-400">
                ChatGPT Plus/Pro subscription or OpenAI API key.
              </p>
            </div>

            <div className="p-3 rounded-lg border border-zinc-800 bg-zinc-900/40">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold text-zinc-200">Claude Code</span>
                {claudeConfigured ? (
                  <span className="flex items-center gap-1 text-[11px] font-mono text-blue-400">
                    <Check className="w-3 h-3" /> Ready
                  </span>
                ) : (
                  <span className="text-[11px] font-mono text-zinc-500">Not set</span>
                )}
              </div>
              <p className="text-[11px] text-zinc-400">
                Claude Pro/Team subscription or Anthropic API key.
              </p>
            </div>
          </div>

          <div className="p-4 sm:p-6 pt-2 space-y-4">
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

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="auth-provider-select" className="block text-xs font-medium text-zinc-300 mb-1.5">
                  Provider
                </label>
                <select
                  id="auth-provider-select"
                  value={provider}
                  onChange={(e) => {
                    setProvider(e.target.value as "codex" | "claude");
                    setActiveFlow(null);
                  }}
                  className="w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-100 focus:outline-hidden focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-colors"
                >
                  <option value="codex">OpenAI Codex</option>
                  <option value="claude">Claude Code</option>
                </select>
              </div>

              <div>
                <label htmlFor="auth-mode-select" className="block text-xs font-medium text-zinc-300 mb-1.5">
                  Authentication style
                </label>
                <select
                  id="auth-mode-select"
                  value={authMode}
                  onChange={(e) => setAuthMode(e.target.value as "subscription" | "api_key")}
                  className="w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-100 focus:outline-hidden focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-colors"
                >
                  <option value="subscription">Subscription session</option>
                  <option value="api_key">API key</option>
                </select>
              </div>
            </div>

            {authMode === "subscription" ? (
              <div className="space-y-4">
                {/* 1. Local Auto-Detection Banner */}
                {currentDetected && (
                  <div className="rounded-xl border border-blue-500/30 bg-blue-950/20 p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Sparkles className="w-4 h-4 text-blue-400" />
                        <span className="text-xs font-semibold text-blue-200">
                          {currentDetected.planName} Detected Locally
                        </span>
                      </div>
                      <span className="text-[11px] font-mono text-blue-400/80 bg-blue-500/10 px-2 py-0.5 rounded border border-blue-500/20">
                        {currentDetected.source}
                      </span>
                    </div>
                    <p className="text-xs text-zinc-300 leading-relaxed">
                      We detected an active {currentDetected.provider === "codex" ? "ChatGPT / Codex" : "Claude Code"} session on this machine{currentDetected.email ? ` (${currentDetected.email})` : ""}. Connect with a single click.
                    </p>
                    <button
                      type="button"
                      onClick={() => handleImportLocal(currentDetected.provider)}
                      disabled={isImporting}
                      className="flex items-center gap-2 px-3.5 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium cursor-pointer transition-colors shadow-xs disabled:opacity-50"
                    >
                      {isImporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                      <span>Connect from Local Session</span>
                    </button>
                  </div>
                )}

                {/* 2. Interactive Browser Sign-In Card */}
                {!activeFlow ? (
                  <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-zinc-200">
                        Browser Sign-In
                      </span>
                      <span className="text-[11px] font-mono text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded border border-blue-500/20">
                        Automated OAuth
                      </span>
                    </div>
                    <p className="text-xs text-zinc-400 leading-relaxed">
                      Authenticate directly in your browser. We relay the authorization seamlessly into your cloud worker environment without manual token handling.
                    </p>
                    <button
                      type="button"
                      onClick={handleStartSignIn}
                      disabled={isStartingFlow}
                      className="flex items-center gap-2 px-4 py-2 rounded-lg bg-zinc-100 hover:bg-white text-zinc-900 text-xs font-semibold cursor-pointer transition-colors shadow-xs disabled:opacity-50"
                    >
                      {isStartingFlow ? (
                        <>
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          <span>Initiating sign-in...</span>
                        </>
                      ) : (
                        <>
                          <ExternalLink className="w-3.5 h-3.5" />
                          <span>Sign in with {provider === "codex" ? "ChatGPT" : "Claude"}</span>
                        </>
                      )}
                    </button>
                  </div>
                ) : (
                  /* Active Flow Progress Card */
                  <div className="rounded-xl border border-blue-500/40 bg-zinc-900/90 p-4 space-y-3 shadow-lg">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />
                        <span className="text-xs font-semibold text-zinc-200">
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
                      <div className="p-3 bg-black/60 rounded-lg border border-zinc-800 space-y-2">
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
                        <div className="text-center font-mono text-xl tracking-widest text-blue-300 font-bold py-1 bg-zinc-900/80 rounded border border-blue-500/20">
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
                          className="flex-1 flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium transition-colors cursor-pointer shadow-xs"
                        >
                          <span>Open Authorization Page</span>
                          <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                      </div>
                    )}

                    <p className="text-[11px] text-zinc-400 text-center">
                      Keep this window open. Once approved in your browser, your session connects automatically.
                    </p>
                  </div>
                )}

                {/* 3. Manual Fallback Section */}
                <div className="pt-2 border-t border-zinc-800/60">
                  <button
                    type="button"
                    onClick={() => setShowManualPaste(!showManualPaste)}
                    className="flex items-center justify-between w-full text-xs text-zinc-400 hover:text-zinc-200 transition-colors py-1 cursor-pointer"
                  >
                    <span>Or paste token / credentials manually</span>
                    {showManualPaste ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                  </button>

                  {showManualPaste && (
                    <form onSubmit={handleSave} className="mt-3 space-y-3">
                      <div>
                        <div className="flex items-center justify-between mb-1.5">
                          <label htmlFor="auth-credential-input" className="block text-xs font-medium text-zinc-300">
                            {provider === "codex" ? "Session JSON (~/.codex/auth.json)" : "Setup Token or ~/.claude.json"}
                          </label>
                        </div>
                        <textarea
                          id="auth-credential-input"
                          rows={3}
                          value={credential}
                          onChange={(e) => setCredential(e.target.value)}
                          placeholder={
                            provider === "codex"
                              ? "Paste ~/.codex/auth.json content..."
                              : "Paste sk-ant-oat01-... or ~/.claude.json content..."
                          }
                          className="w-full px-3 py-2 text-xs font-mono bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-200 placeholder-zinc-500 focus:outline-hidden focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-colors resize-none leading-relaxed"
                        />
                      </div>
                      <div className="flex justify-end">
                        <button
                          type="submit"
                          disabled={isSaving || !credential.trim()}
                          className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium cursor-pointer transition-colors disabled:opacity-50"
                        >
                          {isSaving ? "Saving..." : "Save credentials"}
                        </button>
                      </div>
                    </form>
                  )}
                </div>
              </div>
            ) : (
              /* API Key Form */
              <form onSubmit={handleSave} className="space-y-3">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label htmlFor="auth-credential-input" className="block text-xs font-medium text-zinc-300">
                      {provider === "codex" ? "OpenAI API Key" : "Anthropic API Key"}
                    </label>
                    <a
                      href={
                        provider === "codex"
                          ? "https://platform.openai.com/api-keys"
                          : "https://console.anthropic.com/settings/keys"
                      }
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-[11px] text-blue-400 hover:text-blue-300 transition-colors"
                    >
                      <span>Get key</span>
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                  <input
                    id="auth-credential-input"
                    type="password"
                    value={credential}
                    onChange={(e) => setCredential(e.target.value)}
                    placeholder={provider === "codex" ? "sk-proj-..." : "sk-ant-api03-..."}
                    className="w-full px-3 py-2 text-xs font-mono bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-200 placeholder-zinc-500 focus:outline-hidden focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors"
                  />
                  <p className="text-[11px] text-zinc-500">
                    Standard usage-based API key from the {provider === "codex" ? "OpenAI Platform" : "Anthropic Console"}.
                  </p>
                </div>
                <div className="flex justify-end pt-2">
                  <button
                    type="submit"
                    disabled={isSaving || !credential.trim()}
                    className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium cursor-pointer transition-colors disabled:opacity-50 shadow-xs"
                  >
                    {isSaving ? "Saving..." : "Save API Key"}
                  </button>
                </div>
              </form>
            )}

            <div className="flex items-center justify-end gap-3 pt-3 border-t border-zinc-800">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-xs font-medium text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
