"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getCurrentUser, devLogin } from "../../lib/api";
import { Cpu, Terminal, Shield, GitPullRequest, ArrowRight, Loader2 } from "lucide-react";

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

export default function LoginPage() {
  const router = useRouter();
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [devUsername, setDevUsername] = useState("developer");
  const [showDevForm, setShowDevForm] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    async function checkExistingAuth() {
      try {
        const user = await getCurrentUser();
        if (!ignore && user) {
          if (!user.onboardingCompleted) {
            router.replace("/onboarding");
          } else {
            router.replace("/");
          }
          return;
        }
      } catch {
        // Not authenticated
      } finally {
        if (!ignore) {
          setCheckingAuth(false);
        }
      }
    }

    checkExistingAuth();
    return () => {
      ignore = true;
    };
  }, [router]);

  const handleGitHubLogin = () => {
    setIsLoggingIn(true);
    // OAuth redirect to server API route which 302s to github.com
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = "/api/auth/github";
  };

  const handleDevLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setIsLoggingIn(true);
    try {
      const user = await devLogin(devUsername.trim() || "developer");
      if (!user.onboardingCompleted) {
        router.push("/onboarding");
      } else {
        router.push("/");
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to log in.");
      setIsLoggingIn(false);
    }
  };

  if (checkingAuth) {
    return (
      <div suppressHydrationWarning className="flex min-h-screen w-full items-center justify-center bg-black text-zinc-100">
        <div suppressHydrationWarning className="flex items-center gap-3 text-sm text-zinc-400">
          <Loader2 className="h-4 w-4 animate-spin text-emerald-400" />
          <span>Checking session...</span>
        </div>
      </div>
    );
  }

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
        </div>
        <span className="text-xs text-zinc-500 font-mono">
          Isolated microVM execution
        </span>
      </header>

      {/* Main Content Area */}
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col items-center justify-center px-4 py-12 sm:px-8">
        <div className="grid w-full grid-cols-1 gap-12 lg:grid-cols-12 lg:gap-8 items-center">
          {/* Left Column: Context & Subject */}
          <div className="space-y-6 lg:col-span-7">
            <div className="space-y-3">
              <span className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/20 bg-emerald-950/40 px-2.5 py-1 text-xs text-emerald-400">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                Cloud agent control plane
              </span>
              <h1 className="text-3xl font-semibold tracking-tight text-zinc-100 sm:text-4xl">
                Run autonomous coding agents in isolated microVMs.
              </h1>
              <p className="max-w-xl text-sm leading-relaxed text-zinc-400">
                Execute OpenAI Codex or Claude Code headlessly in disposable Firecracker
                sandboxes. Zero battery drain on your laptop, full terminal streaming,
                and pull requests delivered directly to your repositories.
              </p>
            </div>

            <div className="space-y-3 pt-2">
              <div className="flex items-start gap-3">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-zinc-800 bg-zinc-900 text-zinc-300">
                  <Terminal className="h-3.5 w-3.5 text-emerald-400" />
                </div>
                <div>
                  <h2 className="text-xs font-semibold text-zinc-200">
                    Subscription and API key support
                  </h2>
                  <p className="text-xs text-zinc-400 leading-normal">
                    Use your existing ChatGPT Plus, Pro, or Claude plans via encrypted session tokens, or connect your own API keys.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-3">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-zinc-800 bg-zinc-900 text-zinc-300">
                  <Shield className="h-3.5 w-3.5 text-emerald-400" />
                </div>
                <div>
                  <h2 className="text-xs font-semibold text-zinc-200">
                    MicroVM isolation and egress firewall
                  </h2>
                  <p className="text-xs text-zinc-400 leading-normal">
                    Every task runs in an isolated Linux VM with blocked cloud metadata and strict RFC1918 egress rules.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-3">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-zinc-800 bg-zinc-900 text-zinc-300">
                  <GitPullRequest className="h-3.5 w-3.5 text-emerald-400" />
                </div>
                <div>
                  <h2 className="text-xs font-semibold text-zinc-200">
                    Automated branch and pull request flow
                  </h2>
                  <p className="text-xs text-zinc-400 leading-normal">
                    The agent inspects repo structure, runs tests, and opens pull requests with clear change summaries.
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Right Column: Authentication Card */}
          <div className="lg:col-span-5">
            <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-6 sm:p-8 shadow-2xl">
              <div className="mb-6 space-y-1">
                <h2 className="text-base font-semibold text-zinc-100">
                  Sign in
                </h2>
                <p className="text-xs text-zinc-400">
                  Connect your GitHub account to access your repositories and launch coding tasks.
                </p>
              </div>

              {errorMessage && (
                <div className="mb-4 rounded-lg border border-rose-900/60 bg-rose-950/40 p-3 text-xs text-rose-300">
                  {errorMessage}
                </div>
              )}

              <div className="space-y-3">
                <button
                  type="button"
                  onClick={handleGitHubLogin}
                  disabled={isLoggingIn}
                  className="flex w-full items-center justify-center gap-2.5 rounded-lg bg-zinc-100 px-4 py-2.5 text-xs font-medium text-black transition-colors hover:bg-zinc-200 disabled:opacity-50 cursor-pointer shadow-xs"
                >
                  {isLoggingIn ? (
                    <Loader2 className="h-4 w-4 animate-spin text-black" />
                  ) : (
                    <GitHubIcon className="h-4 w-4" />
                  )}
                  <span>Continue with GitHub</span>
                </button>

                <div className="relative my-4 flex items-center justify-center">
                  <div className="absolute inset-0 flex items-center">
                    <div className="w-full border-t border-zinc-800" />
                  </div>
                  <span className="relative bg-zinc-950 px-2 text-[11px] text-zinc-500">
                    or local environment
                  </span>
                </div>

                {!showDevForm ? (
                  <button
                    type="button"
                    onClick={() => setShowDevForm(true)}
                    className="flex w-full items-center justify-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/70 px-4 py-2.5 text-xs font-medium text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-100 cursor-pointer"
                  >
                    <span>Developer quickstart</span>
                    <ArrowRight className="h-3 w-3 text-zinc-500" />
                  </button>
                ) : (
                  <form onSubmit={handleDevLogin} className="space-y-3 pt-1">
                    <div>
                      <label
                        htmlFor="dev-username-input"
                        className="block text-xs font-medium text-zinc-300 mb-1"
                      >
                        Local username
                      </label>
                      <input
                        id="dev-username-input"
                        type="text"
                        value={devUsername}
                        onChange={(e) => setDevUsername(e.target.value)}
                        placeholder="developer"
                        required
                        className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-zinc-100 placeholder-zinc-500 focus:border-emerald-500 focus:outline-hidden"
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={isLoggingIn || !devUsername.trim()}
                      className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50 cursor-pointer shadow-xs"
                    >
                      {isLoggingIn ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <span>Log in as local developer</span>
                      )}
                    </button>
                  </form>
                )}
              </div>

              <div className="mt-6 border-t border-zinc-900 pt-4">
                <p className="text-[11px] text-zinc-500 leading-normal">
                  Your credentials and session files are encrypted with AES-256-GCM before writing to the database.
                </p>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-zinc-900 px-6 py-4 text-center text-xs text-zinc-600">
        Cloud Worker. Autonomous agent control plane and in-microVM subscription harness.
      </footer>
    </div>
  );
}
