#!/usr/bin/env node
/**
 * In-VM Claude Agent SDK runner for Cloud Worker.
 *
 * Executes inside the E2B microVM next to /workspace and drives the official
 * @anthropic-ai/claude-agent-sdk.
 * Emits one protocol line per event on stdout:
 *
 *   CW1 {"t":"ready","sdk":"...","node":"...","resumed":false}
 *   CW1 {"t":"session","id":"<session_id>","resumed":true|false}
 *   CW1 {"t":"ev","e":{...raw SDK Message...}}
 *   CW1 {"t":"log","m":"diagnostic text"}
 *   CW1 {"t":"result","code":0,"usage":{...}|null,"final":"...","error":"..."}
 *
 * Environment contract (set by the control plane):
 *   CW_PROMPT_FILE   path to the prompt text file (required)
 *   CW_SESSION_FILE  path used to persist the session id across turns
 *   CW_CONTINUE      "1" to resume the previous session
 *   CW_CWD           working directory for the agent (default /workspace)
 *   CW_MODEL         model override (optional)
 *   CW_EFFORT        reasoning effort: low | medium | high (optional)
 *   CLAUDE_CODE_OAUTH_TOKEN  user subscription OAuth token (inherited)
 *   ANTHROPIC_API_KEY        used when the task runs in API-key mode
 *   CLAUDE_CLI_PATH  optional path to native claude executable
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const CLAUDE_SDK_VERSION = "0.3.319";

function emit(obj) {
  process.stdout.write("CW1 " + JSON.stringify(obj) + "\n");
}

function envStr(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

function finish(code) {
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

  const sessionFile = envStr("CW_SESSION_FILE", "/home/user/.cloud-worker/claude-session-id");
  const cwd = envStr("CW_CWD", "/workspace");
  const shouldContinue = process.env.CW_CONTINUE === "1";
  const model = process.env.CW_MODEL || undefined;
  const effort = process.env.CW_EFFORT || undefined;

  let query;
  try {
    ({ query } = await import("@anthropic-ai/claude-agent-sdk"));
  } catch (err) {
    emit({ t: "log", m: "failed to import @anthropic-ai/claude-agent-sdk: " + (err && err.message) });
    emit({ t: "result", code: 2, error: "claude agent sdk not installed in microVM" });
    finish(2);
    return;
  }

  const options = {
    cwd,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    persistSession: true,
  };

  if (model && model !== "claude" && model !== "codex") {
    options.model = model;
  }

  if (effort && effort !== "none") {
    options.effort = effort;
  }

  if (process.env.CLAUDE_CLI_PATH) {
    options.pathToClaudeCodeExecutable = process.env.CLAUDE_CLI_PATH;
  }

  let resumed = false;
  if (shouldContinue && existsSync(sessionFile)) {
    const previousId = readFileSync(sessionFile, "utf8").trim();
    if (previousId) {
      options.resume = previousId;
      resumed = true;
    }
  }

  emit({ t: "ready", sdk: CLAUDE_SDK_VERSION, node: process.version, resumed });

  const abort = new AbortController();
  process.on("SIGTERM", () => abort.abort());
  options.abortController = abort;

  let usage = null;
  let modelUsage = null;
  let totalCostUsd = null;
  let finalMessage;
  let failure;

  const runQueryStream = async (queryOptions) => {
    const stream = query({ prompt, options: queryOptions });
    for await (const message of stream) {
      if (message.session_id) {
        try {
          writeFileSync(sessionFile, message.session_id);
        } catch {
          // Best effort persistence
        }
        emit({ t: "session", id: message.session_id, resumed });
      }

      if (message.type === "result") {
        if (message.usage) usage = message.usage;
        if (message.modelUsage) modelUsage = message.modelUsage;
        if (message.total_cost_usd !== undefined) totalCostUsd = message.total_cost_usd;
        if (message.result) finalMessage = message.result;
        if (message.is_error) {
          failure = message.result || message.subtype || "Claude execution error";
        }
      } else if (message.type === "assistant" && message.message?.content) {
        for (const block of message.message.content) {
          if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
            finalMessage = block.text.trim();
          }
        }
      }

      emit({ t: "ev", e: message });
    }
  };

  try {
    await runQueryStream(options);
  } catch (err) {
    if (resumed && !abort.signal.aborted) {
      emit({
        t: "log",
        m: "session resume failed, starting fresh session: " + (err && err.message ? err.message : String(err)),
      });
      delete options.resume;
      resumed = false;
      try {
        await runQueryStream(options);
      } catch (freshErr) {
        failure = freshErr && freshErr.message ? freshErr.message : String(freshErr);
      }
    } else {
      failure = err && err.message ? err.message : String(err);
    }
  }

  if (failure) {
    emit({ t: "result", code: 1, error: failure, usage, modelUsage, totalCostUsd });
    finish(1);
    return;
  }

  emit({ t: "result", code: 0, usage, modelUsage, totalCostUsd, final: finalMessage });
  finish(0);
}

main().catch((err) => {
  emit({ t: "result", code: 1, error: err && err.message ? err.message : String(err) });
  finish(1);
});
