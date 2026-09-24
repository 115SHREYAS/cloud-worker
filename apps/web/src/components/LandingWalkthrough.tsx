"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Cpu,
  Terminal,
  Shield,
  GitPullRequest,
  Sparkles,
  Loader2,
} from "lucide-react";

interface LandingWalkthroughProps {
  onDevLogin: (username?: string) => Promise<void>;
}

function GitHubLogo({ className = "w-4 h-4" }: { className?: string }) {
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

export function LandingWalkthrough({ onDevLogin }: LandingWalkthroughProps) {
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  const handleDevQuickstart = async () => {
    setIsLoggingIn(true);
    try {
      await onDevLogin("developer");
    } finally {
      setIsLoggingIn(false);
    }
  };

  return (
    <div className="flex min-h-screen w-full flex-col justify-between bg-black text-zinc-100 font-sans selection:bg-blue-500/20 selection:text-blue-300">
      {/* Top Header */}
      <header className="flex h-16 w-full items-center justify-between border-b border-zinc-900 px-6 sm:px-12">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-blue-500/20 bg-blue-500/10 text-blue-400">
            <Cpu className="h-4 w-4" />
          </div>
          <span className="text-sm font-semibold tracking-tight text-zinc-100">
            Cloud Worker
          </span>
        </div>

        <div className="flex items-center gap-3">
          <Link
            href="/login"
            className="text-xs font-medium text-zinc-400 hover:text-zinc-100 transition-colors px-3 py-1.5"
          >
            Log in
          </Link>
          <a
            href="/api/auth/github"
            className="inline-flex items-center gap-2 rounded-lg bg-zinc-100 px-3.5 py-1.5 text-xs font-medium text-black hover:bg-zinc-200 transition-colors"
          >
            <GitHubLogo className="h-3.5 w-3.5" />
            <span>Sign in</span>
          </a>
        </div>
      </header>

      {/* Main Single-View Hero */}
      <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col items-center justify-center px-6 py-12 text-center">
        {/* Status Pill */}
        <div className="inline-flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900/60 px-3 py-1 text-xs text-zinc-300 mb-6">
          <span className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse" />
          <span>Firecracker MicroVMs + In-VM Agent Harness</span>
        </div>

        {/* Heading */}
        <h1 className="text-4xl sm:text-6xl font-semibold tracking-tight text-zinc-100 leading-[1.15] max-w-3xl">
          Autonomous coding agents in isolated cloud sandboxes.
        </h1>

        {/* Concise Description */}
        <p className="mt-5 max-w-2xl text-sm sm:text-base text-zinc-400 leading-relaxed">
          Cloud Worker runs Claude Code and OpenAI Codex headlessly inside disposable
          Linux microVMs. Watch live terminal output, inspect code diffs in real time, and
          receive tested pull requests on your repositories.
        </p>

        {/* Primary Call to Action */}
        <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3 w-full sm:w-auto">
          <a
            href="/api/auth/github"
            className="flex w-full sm:w-auto items-center justify-center gap-2.5 rounded-xl bg-blue-600 px-6 py-3 text-xs sm:text-sm font-semibold text-white transition-colors hover:bg-blue-500 shadow-sm"
          >
            <GitHubLogo className="h-4 w-4" />
            <span>Sign up with GitHub</span>
          </a>

          <button
            type="button"
            onClick={handleDevQuickstart}
            disabled={isLoggingIn}
            className="flex w-full sm:w-auto items-center justify-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900/70 px-5 py-3 text-xs sm:text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-100 cursor-pointer"
          >
            {isLoggingIn ? (
              <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
            ) : (
              <Sparkles className="h-4 w-4 text-blue-400" />
            )}
            <span>Developer quickstart</span>
          </button>
        </div>

        {/* 3 Core Highlights */}
        <div className="mt-12 grid grid-cols-1 sm:grid-cols-3 gap-3 w-full max-w-2xl text-left">
          <div className="rounded-lg border border-zinc-800/80 bg-zinc-950/60 p-3.5 space-y-1">
            <div className="flex items-center gap-2 text-xs font-medium text-zinc-200">
              <Terminal className="h-3.5 w-3.5 text-blue-400" />
              <span>Full bash sandbox</span>
            </div>
            <p className="text-[11px] text-zinc-500 leading-normal">
              Ephemeral Linux microVM booted in 2 seconds per task.
            </p>
          </div>

          <div className="rounded-lg border border-zinc-800/80 bg-zinc-950/60 p-3.5 space-y-1">
            <div className="flex items-center gap-2 text-xs font-medium text-zinc-200">
              <Shield className="h-3.5 w-3.5 text-blue-400" />
              <span>Blocked egress</span>
            </div>
            <p className="text-[11px] text-zinc-500 leading-normal">
              Cloud metadata and internal IP access restricted by firewall.
            </p>
          </div>

          <div className="rounded-lg border border-zinc-800/80 bg-zinc-950/60 p-3.5 space-y-1">
            <div className="flex items-center gap-2 text-xs font-medium text-zinc-200">
              <GitPullRequest className="h-3.5 w-3.5 text-blue-400" />
              <span>Automated PRs</span>
            </div>
            <p className="text-[11px] text-zinc-500 leading-normal">
              Agents push branch commits and open verified pull requests.
            </p>
          </div>
        </div>
      </main>

      {/* Minimal Footer */}
      <footer className="flex h-12 w-full items-center justify-between border-t border-zinc-900 px-6 sm:px-12 text-[11px] text-zinc-600">
        <span>Cloud Worker Control Plane</span>
        <span>Isolated microVM execution</span>
      </footer>
    </div>
  );
}
