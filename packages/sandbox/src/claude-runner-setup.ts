import { readFile } from "node:fs/promises";
import type { SandboxManager } from "./sandbox";

/**
 * Installs and uploads the in-VM Claude Agent SDK runner so Claude tasks execute
 * via the official @anthropic-ai/claude-agent-sdk instead of raw `claude` CLI stdout.
 * Returns false when the install or a smoke import fails, letting AgentSession
 * fall back to the plain CLI path.
 */

export const CLAUDE_RUNNER_DIR = "/home/user/.cloud-worker/claude-runner";
export const CLAUDE_RUNNER_SCRIPT = `${CLAUDE_RUNNER_DIR}/runner.mjs`;
export const CLAUDE_SESSION_FILE = "/home/user/.cloud-worker/claude-session-id";
export const CLAUDE_SDK_VERSION = "0.3.319";

let runnerSourceCache: string | undefined;

async function loadRunnerSource(): Promise<string> {
  if (!runnerSourceCache) {
    runnerSourceCache = await readFile(
      new URL("./agent/claude-runner.mjs", import.meta.url),
      "utf8",
    );
  }
  return runnerSourceCache;
}

export async function ensureClaudeSdkRunner(sandbox: SandboxManager): Promise<boolean> {
  // Fast path for warm VMs and follow-up turns: runner and SDK already present.
  const check = await sandbox.exec(
    `test -f "${CLAUDE_RUNNER_SCRIPT}" && test -d "${CLAUDE_RUNNER_DIR}/node_modules/@anthropic-ai/claude-agent-sdk"`,
  );
  if (check.exitCode === 0) {
    return true;
  }

  await sandbox.makeDir(CLAUDE_RUNNER_DIR);
  await sandbox.writeFile(
    `${CLAUDE_RUNNER_DIR}/package.json`,
    JSON.stringify(
      {
        name: "cw-claude-runner",
        private: true,
        type: "module",
        dependencies: {
          "@anthropic-ai/claude-agent-sdk": CLAUDE_SDK_VERSION,
        },
      },
      null,
      2,
    ),
  );
  await sandbox.writeFile(CLAUDE_RUNNER_SCRIPT, await loadRunnerSource());

  // npm inside the microVM occasionally fails with transient SSL/cipher errors; retry absorbs them.
  let install = await sandbox.exec(
    "npm install --omit=dev --no-audit --no-fund --loglevel=error",
    { cwd: CLAUDE_RUNNER_DIR, timeoutMs: 300_000 },
  );
  if (install.exitCode !== 0) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    install = await sandbox.exec(
      "npm install --omit=dev --no-audit --no-fund --loglevel=error",
      { cwd: CLAUDE_RUNNER_DIR, timeoutMs: 300_000 },
    );
  }
  if (install.exitCode !== 0) {
    console.warn(
      `[claude-runner] npm install of @anthropic-ai/claude-agent-sdk failed (code ${install.exitCode}): ${install.stderr.slice(0, 500)}`,
    );
    return false;
  }

  // Smoke test: the SDK imports and loads cleanly.
  const smoke = await sandbox.exec(
    `node -e "import('@anthropic-ai/claude-agent-sdk').then(() => console.log('SDK_OK'), (e) => { console.error(e.message); process.exit(1); })"`,
    { cwd: CLAUDE_RUNNER_DIR, timeoutMs: 60_000 },
  );
  if (smoke.exitCode !== 0 || !smoke.stdout.includes("SDK_OK")) {
    console.warn(
      `[claude-runner] claude agent sdk smoke test failed: ${smoke.stderr.slice(0, 500)}`,
    );
    return false;
  }

  return true;
}
