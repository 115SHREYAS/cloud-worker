#!/usr/bin/env node
/**
 * In-VM Codex SDK runner for Cloud Worker.
 *
 * Executes inside the E2B microVM next to /workspace and drives the official
 * @openai/codex-sdk (which spawns the codex CLI in --experimental-json mode).
 * Emits one protocol line per event on stdout:
 *
 *   CW1 {"t":"ready","sdk":"...","node":"...","resumed":false}
 *   CW1 {"t":"thread","id":"<thread_id>","resumed":true|false}
 *   CW1 {"t":"ev","e":{...raw SDK ThreadEvent...}}
 *   CW1 {"t":"log","m":"diagnostic text"}
 *   CW1 {"t":"result","code":0,"usage":{...}|null,"final":"...","error":"..."}
 *
 * Environment contract (set by the control plane):
 *   CW_PROMPT_FILE  path to the prompt text file (required)
 *   CW_THREAD_FILE  path used to persist the thread id across turns
 *   CW_CONTINUE     "1" to resume the previous thread
 *   CW_CWD          working directory for the agent (default /workspace)
 *   CW_MODEL        model override (optional)
 *   CW_EFFORT       reasoning effort: low | medium | high (optional)
 *   CODEX_HOME      auth.json location (inherited by the CLI child)
 *   OPENAI_API_KEY  used when the task runs in API-key mode
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const CODEX_SDK_VERSION = "0.164.0";

function emit(obj) {
  process.stdout.write("CW1 " + JSON.stringify(obj) + "\n");
}

function envStr(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

function finish(code) {
  // Give stdout a beat to flush, then exit hard so a hung child can never
  // pin the turn open until the E2B command timeout.
  process.exitCode = code;
  const hardExit = setTimeout(() => process.exit(code), 500);
  hardExit.unref();
}

async function main() {
  const promptFile = envStr("CW_PROMPT_FILE", "");
  if (!promptFile) {
    emit({ t: "result", code: 2, error: "CW_PROMPT_FILE not set" });
    finish(2);
    return;
  }
  const prompt = readFileSync(promptFile, "utf8");

  const threadFile = envStr("CW_THREAD_FILE", "/home/user/.cloud-worker/codex-thread-id");
  const cwd = envStr("CW_CWD", "/workspace");
  const shouldContinue = process.env.CW_CONTINUE === "1";
  const model = process.env.CW_MODEL || undefined;
  const effort = process.env.CW_EFFORT || undefined;

  let Codex;
  try {
    ({ Codex } = await import("@openai/codex-sdk"));
  } catch (err) {
    emit({ t: "log", m: "failed to import @openai/codex-sdk: " + (err && err.message) });
    emit({ t: "result", code: 2, error: "codex sdk not installed in microVM" });
    finish(2);
    return;
  }

  // The E2B sandbox is already an isolated, egress-firewalled VM dedicated to
  // this one task, so the agent runs with full access and no approval gates —
  // equivalent to the previous `--dangerously-bypass-approvals-and-sandbox`.
  const threadOptions = {
    workingDirectory: cwd,
    sandboxMode: "danger-full-access",
    approvalPolicy: "never",
    skipGitRepoCheck: true,
  };
  if (model) threadOptions.model = model;
  if (effort) threadOptions.modelReasoningEffort = effort;

  // No `env` option on purpose: the SDK then copies this process's
  // environment to the CLI child, preserving CODEX_HOME / OPENAI_API_KEY.
  const codexOptions = {};
  if (process.env.OPENAI_API_KEY) codexOptions.apiKey = process.env.OPENAI_API_KEY;
  const codex = new Codex(codexOptions);

  let thread = null;
  let resumed = false;
  if (shouldContinue && existsSync(threadFile)) {
    const previousId = readFileSync(threadFile, "utf8").trim();
    if (previousId) {
      try {
        thread = codex.resumeThread(previousId, threadOptions);
        resumed = true;
      } catch (err) {
        emit({ t: "log", m: "thread resume failed, starting fresh: " + (err && err.message ? err.message : String(err)) });
      }
    }
  }
  if (!thread) {
    thread = codex.startThread(threadOptions);
  }

  emit({ t: "ready", sdk: CODEX_SDK_VERSION, node: process.version, resumed });

  const abort = new AbortController();
  process.on("SIGTERM", () => abort.abort());

  let usage = null;
  let finalMessage;
  let failure;

  try {
    const { events } = await thread.runStreamed(prompt, { signal: abort.signal });

    for await (const event of events) {
      if (event.type === "thread.started" && event.thread_id) {
        try {
          writeFileSync(threadFile, event.thread_id);
        } catch {
          // Best effort persistence; resume falls back to a fresh thread.
        }
        emit({ t: "thread", id: event.thread_id, resumed });
        continue;
      }
      if (event.type === "turn.completed") {
        usage = event.usage || null;
      } else if (event.type === "turn.failed") {
        failure = (event.error && event.error.message) || "turn failed";
      } else if (
        event.type === "item.completed" &&
        event.item &&
        event.item.type === "agent_message" &&
        event.item.text
      ) {
        finalMessage = event.item.text;
      }
      emit({ t: "ev", e: event });
    }
  } catch (err) {
    failure = err && err.message ? err.message : String(err);
  }

  if (failure) {
    emit({ t: "result", code: 1, error: failure, usage });
    finish(1);
    return;
  }

  emit({ t: "result", code: 0, usage, final: finalMessage });
  finish(0);
}

main().catch((err) => {
  emit({ t: "result", code: 1, error: err && err.message ? err.message : String(err) });
  finish(1);
});
