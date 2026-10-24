"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { getCurrentUser } from "../../lib/api";
import { Loader2 } from "lucide-react";

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
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    async function checkExistingAuth() {
      try {
        const user = await getCurrentUser();
        if (!ignore && user) {
          router.replace("/");
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
    setErrorMessage(null);
    window.location.href = "/api/auth/github";
  };

  if (checkingAuth) {
    return (
      <div suppressHydrationWarning className="flex min-h-screen w-full items-center justify-center bg-black text-zinc-100">
        <div suppressHydrationWarning className="flex items-center gap-3 text-sm text-zinc-400">
          <Loader2 className="h-4 w-4 animate-spin text-blue-400" />
          <span>Checking session...</span>
        </div>
      </div>
    );
  }

  return (
    <div
      suppressHydrationWarning
      className="flex min-h-screen w-full flex-col justify-between bg-black text-zinc-100 selection:bg-blue-500/20 selection:text-blue-300 font-sans"
    >
      {/* Header */}
      <header className="flex h-16 w-full items-center justify-between border-b border-zinc-900 px-6 sm:px-12">
        <Link href="/" className="flex items-center gap-2.5 group">
          <img src="/logo.svg" alt="Cloud Worker" className="h-8 w-8 rounded-lg shadow-xs" />
          <span className="text-sm font-semibold tracking-tight text-zinc-100 group-hover:text-white transition-colors">
            Cloud Worker
          </span>
        </Link>
        <Link
          href="/"
          className="text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          Home
        </Link>
      </header>

      {/* Main Content: Centralized Login / Signup Card */}
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center px-4 py-12">
        <div className="w-full rounded-2xl border border-zinc-800 bg-[#0c0d12] p-8 shadow-2xl">
          {/* Card Header & Tabs */}
          <div className="mb-6 space-y-4">
            <div className="flex rounded-lg border border-zinc-800 bg-zinc-950 p-1">
              <button
                type="button"
                onClick={() => setMode("signin")}
                className={`flex-1 rounded-md py-1.5 text-xs font-medium transition-colors cursor-pointer ${
                  mode === "signin"
                    ? "bg-zinc-800 text-zinc-100 shadow-xs"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                Sign in
              </button>
              <button
                type="button"
                onClick={() => setMode("signup")}
                className={`flex-1 rounded-md py-1.5 text-xs font-medium transition-colors cursor-pointer ${
                  mode === "signup"
                    ? "bg-zinc-800 text-zinc-100 shadow-xs"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                Sign up
              </button>
            </div>

            <div className="space-y-1.5 text-center">
              <h1 className="text-xl font-semibold tracking-tight text-zinc-100">
                {mode === "signin" ? "Sign in to Cloud Worker" : "Create an account"}
              </h1>
              <p className="text-xs text-zinc-400">
                {mode === "signin"
                  ? "Connect your GitHub account to access your repositories and tasks."
                  : "Sign up with GitHub to start running autonomous coding agents."}
              </p>
            </div>
          </div>

          {errorMessage && (
            <div className="mb-4 rounded-lg border border-rose-900/60 bg-rose-950/40 p-3 text-xs text-rose-300">
              {errorMessage}
            </div>
          )}

          {/* Action Button */}
          <div className="space-y-4">
            <button
              type="button"
              onClick={handleGitHubLogin}
              disabled={isLoggingIn}
              className="flex w-full items-center justify-center gap-2.5 rounded-xl bg-zinc-100 px-4 py-3 text-xs sm:text-sm font-semibold text-black transition-colors hover:bg-zinc-200 disabled:opacity-50 cursor-pointer shadow-xs"
            >
              {isLoggingIn ? (
                <Loader2 className="h-4 w-4 animate-spin text-black" />
              ) : (
                <GitHubIcon className="h-4 w-4" />
              )}
              <span>
                {mode === "signin" ? "Continue with GitHub" : "Sign up with GitHub"}
              </span>
            </button>

            <div className="text-center text-xs text-zinc-400">
              {mode === "signin" ? (
                <span>
                  New to Cloud Worker?{" "}
                  <button
                    type="button"
                    onClick={() => setMode("signup")}
                    className="text-blue-400 hover:underline cursor-pointer font-medium"
                  >
                    Create an account
                  </button>
                </span>
              ) : (
                <span>
                  Already have an account?{" "}
                  <button
                    type="button"
                    onClick={() => setMode("signin")}
                    className="text-blue-400 hover:underline cursor-pointer font-medium"
                  >
                    Sign in
                  </button>
                </span>
              )}
            </div>
          </div>

          {/* Privacy Note */}
          <div className="mt-6 border-t border-zinc-900 pt-4 text-center">
            <p className="text-[11px] text-zinc-500">
              Requires a GitHub account to manage repositories and open pull requests.
            </p>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-zinc-900 px-6 py-4 text-center text-xs text-zinc-600">
        Cloud Worker
      </footer>
    </div>
  );
}
