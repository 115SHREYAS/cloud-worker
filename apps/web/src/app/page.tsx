import Image from "next/image";
import { TaskStatusSchema, AGENT_TOOLS } from "@cloud-worker/shared";

export default function Home() {
  return (
    <div className="flex flex-col flex-1 items-center justify-center min-h-screen bg-zinc-50 font-sans dark:bg-black p-8">
      <main className="flex flex-1 w-full max-w-3xl flex-col items-start py-12 px-8 bg-white dark:bg-zinc-950 rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-sm">
        <div className="flex items-center gap-3 mb-6">
          <Image
            className="dark:invert"
            src="/next.svg"
            alt="Next.js logo"
            width={90}
            height={18}
            priority
          />
          <span className="text-xs font-semibold px-2 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300">
            Next.js + Bun Monorepo
          </span>
        </div>

        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-50 mb-2">
          Cloud Coding Agent Dashboard
        </h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-8">
          Autonomous coding agent control plane and microVM sandbox runner.
        </p>

        <div className="w-full space-y-6">
          <div className="p-4 bg-zinc-50 dark:bg-zinc-900/50 rounded-lg border border-zinc-100 dark:border-zinc-800">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-3">
              Supported Task Statuses
            </h2>
            <div className="flex flex-wrap gap-2">
              {TaskStatusSchema.options.map((status) => (
                <span
                  key={status}
                  className="px-2.5 py-1 text-xs rounded-full bg-blue-100 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 font-mono"
                >
                  {status}
                </span>
              ))}
            </div>
          </div>

          <div className="p-4 bg-zinc-50 dark:bg-zinc-900/50 rounded-lg border border-zinc-100 dark:border-zinc-800">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-3">
              Available Agent Tools ({AGENT_TOOLS.length})
            </h2>
            <div className="flex flex-wrap gap-2">
              {AGENT_TOOLS.map((tool) => (
                <span
                  key={tool.name}
                  className="px-2.5 py-1 text-xs rounded-md bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 font-mono"
                >
                  {tool.name}
                </span>
              ))}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
