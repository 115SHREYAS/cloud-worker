import { readFile } from "node:fs/promises";
import type { SandboxManager } from "./sandbox";

/**
 * Installs and uploads the in-VM Codex SDK runner so codex tasks execute via
 * the official @openai/codex-sdk instead of raw `codex exec` stdout. The SDK
 * package pins the codex CLI binary as its own dependency, so one npm install
 * in the runner directory provides both. Returns false when the install or a
 * smoke import fails, letting AgentSession fall back to the plain CLI path.
 */

export const CODEX_RUNNER_DIR = "/home/user/.cloud-worker/codex-runner";
export const CODEX_RUNNER_SCRIPT = `${CODEX_RUNNER_DIR}/runner.mjs`;
export const CODEX_THREAD_FILE = "/home/user/.cloud-worker/codex-thread-id";
export const CODEX_SDK_VERSION = "0.164.0";

let runnerSourceCache: string | undefined;

async function loadRunnerSource(): Promise<string> {
  if (!runnerSourceCache) {
    runnerSourceCache = await readFile(
      new URL("./agent/codex-runner.mjs", import.meta.url),
      "utf8",
    );
  }
  return runnerSourceCache;
}

export async function ensureCodexSdkRunner(sandbox: SandboxManager): Promise<boolean> {
  // Fast path for warm VMs and follow-up turns: runner and SDK already present.
  const check = await sandbox.exec(
    `test -f "${CODEX_RUNNER_SCRIPT}" && test -d "${CODEX_RUNNER_DIR}/node_modules/@openai/codex-sdk"`,
  );
  if (check.exitCode === 0) {
    return true;
  }

  await sandbox.makeDir(CODEX_RUNNER_DIR);
  await sandbox.writeFile(
    `${CODEX_RUNNER_DIR}/package.json`,
    JSON.stringify(
      {
        name: "cw-codex-runner",
        private: true,
        type: "module",
        dependencies: {
          "@openai/codex-sdk": CODEX_SDK_VERSION,
        },
      },
      null,
      2,
    ),
  );
  await sandbox.writeFile(CODEX_RUNNER_SCRIPT, await loadRunnerSource());

  // npm inside the microVM occasionally fails with transient SSL/cipher
  // errors (ERR_SSL_CIPHER_OPERATION_FAILED); one retry absorbs them.
  let install = await sandbox.exec(
    "npm install --omit=dev --no-audit --no-fund --loglevel=error",
    { cwd: CODEX_RUNNER_DIR, timeoutMs: 300_000 },
  );
  if (install.exitCode !== 0) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    install = await sandbox.exec(
      "npm install --omit=dev --no-audit --no-fund --loglevel=error",
      { cwd: CODEX_RUNNER_DIR, timeoutMs: 300_000 },
    );
  }
  if (install.exitCode !== 0) {
    console.warn(
      `[codex-runner] npm install of @openai/codex-sdk failed (code ${install.exitCode}): ${install.stderr.slice(0, 500)}`,
    );
    return false;
  }

  // Smoke test: the SDK imports and its vendored platform binary resolves.
  const smoke = await sandbox.exec(
    `node -e "import('@openai/codex-sdk').then(() => console.log('SDK_OK'), (e) => { console.error(e.message); process.exit(1); })"`,
    { cwd: CODEX_RUNNER_DIR, timeoutMs: 60_000 },
  );
  if (smoke.exitCode !== 0 || !smoke.stdout.includes("SDK_OK")) {
    console.warn(
      `[codex-runner] codex sdk smoke test failed: ${smoke.stderr.slice(0, 500)}`,
    );
    return false;
  }

  return true;
}
