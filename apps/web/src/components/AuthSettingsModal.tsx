"use client";

import { useState, useEffect } from "react";
import { fetchAuthStatus, saveAuthSession } from "../lib/api";
import { X, KeyRound, Check, AlertCircle, Loader2 } from "lucide-react";

interface AuthSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function AuthSettingsModal({ isOpen, onClose }: AuthSettingsModalProps) {
  const [provider, setProvider] = useState<"codex" | "claude">("codex");
  const [authJson, setAuthJson] = useState("");
  const [codexConfigured, setCodexConfigured] = useState<boolean | null>(null);
  const [claudeConfigured, setClaudeConfigured] = useState<boolean | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    let ignore = false;
    async function checkStatus() {
      try {
        const [codex, claude] = await Promise.all([
          fetchAuthStatus("codex").catch(() => ({ configured: false })),
          fetchAuthStatus("claude").catch(() => ({ configured: false })),
        ]);
        if (!ignore) {
          setCodexConfigured(codex.configured);
          setClaudeConfigured(claude.configured);
        }
      } catch {
        // Ignore background errors
      }
    }

    checkStatus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      ignore = true;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setSuccessMsg(null);

    if (!authJson.trim()) {
      setErrorMsg("Please enter valid auth session JSON or API token");
      return;
    }

    setIsSaving(true);
    try {
      await saveAuthSession(provider, authJson.trim());
      setSuccessMsg(`Saved subscription session credentials for ${provider}`);
      setAuthJson("");
      const [codex, claude] = await Promise.all([
        fetchAuthStatus("codex").catch(() => ({ configured: false })),
        fetchAuthStatus("claude").catch(() => ({ configured: false })),
      ]);
      setCodexConfigured(codex.configured);
      setClaudeConfigured(claude.configured);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-xs">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-modal-title"
        className="w-full max-w-xl bg-zinc-950 border border-zinc-800 rounded-xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 bg-zinc-900/60">
          <div className="flex items-center gap-2.5">
            <span className="flex items-center justify-center w-7 h-7 rounded-lg bg-blue-500/10 text-blue-400 border border-blue-500/20">
              <KeyRound className="w-4 h-4" />
            </span>
            <div>
              <h2 id="auth-modal-title" className="text-base font-semibold text-zinc-100">
                Subscription credentials
              </h2>
              <p className="text-xs text-zinc-400 mt-0.5">
                Inject OAuth session tokens into microVMs to run under subscription quotas.
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

        {/* Status Indicators */}
        <div className="grid grid-cols-2 gap-3 p-6 pb-2">
          <div className="p-3 rounded-lg border border-zinc-800 bg-zinc-900/40">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-semibold text-zinc-200">OpenAI Codex</span>
              {codexConfigured ? (
                <span className="flex items-center gap-1 text-[11px] font-mono text-emerald-400">
                  <Check className="w-3 h-3" /> Ready
                </span>
              ) : (
                <span className="text-[11px] font-mono text-zinc-500">Not set</span>
              )}
            </div>
            <p className="text-[11px] text-zinc-400">
              Uses ChatGPT Plus / Pro / Team subscription quota.
            </p>
          </div>

          <div className="p-3 rounded-lg border border-zinc-800 bg-zinc-900/40">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-semibold text-zinc-200">Claude Code</span>
              {claudeConfigured ? (
                <span className="flex items-center gap-1 text-[11px] font-mono text-emerald-400">
                  <Check className="w-3 h-3" /> Ready
                </span>
              ) : (
                <span className="text-[11px] font-mono text-zinc-500">Not set</span>
              )}
            </div>
            <p className="text-[11px] text-zinc-400">
              Uses Claude Pro / Team subscription quota.
            </p>
          </div>
        </div>

        {/* Form */}
        <form onSubmit={handleSave} className="p-6 pt-2 space-y-4">
          {successMsg && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-emerald-950/40 border border-emerald-900/60 text-emerald-300 text-xs">
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

          <div>
            <label htmlFor="auth-provider-select" className="block text-xs font-medium text-zinc-300 mb-1.5">
              Provider
            </label>
            <select
              id="auth-provider-select"
              value={provider}
              onChange={(e) => setProvider(e.target.value as "codex" | "claude")}
              className="w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-100 focus:outline-hidden focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors"
            >
              <option value="codex">OpenAI Codex (~/.codex/auth.json)</option>
              <option value="claude">Claude Code (~/.claude.json)</option>
            </select>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label htmlFor="auth-json-input" className="block text-xs font-medium text-zinc-300">
                Session JSON contents
              </label>
              <span className="text-[11px] text-zinc-500 font-mono">
                {provider === "codex" ? "/root/.codex/auth.json" : "/root/.claude.json"}
              </span>
            </div>
            <textarea
              id="auth-json-input"
              rows={5}
              value={authJson}
              onChange={(e) => setAuthJson(e.target.value)}
              placeholder={`Paste the contents of your local ${provider === "codex" ? "~/.codex/auth.json" : "~/.claude.json"} file here...`}
              className="w-full px-3 py-2 text-xs font-mono bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-200 placeholder-zinc-500 focus:outline-hidden focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors resize-none leading-relaxed"
            />
          </div>

          <div className="flex items-center justify-end gap-3 pt-3 border-t border-zinc-800">
            <button
              type="button"
              onClick={onClose}
              disabled={isSaving}
              className="px-4 py-2 text-xs font-medium rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors cursor-pointer"
            >
              Done
            </button>
            <button
              type="submit"
              disabled={isSaving || !authJson.trim()}
              className="flex items-center gap-2 px-4 py-2 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-500 text-white shadow-xs transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSaving ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Saving...</span>
                </>
              ) : (
                <span>Save credentials</span>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
