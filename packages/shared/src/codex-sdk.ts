import { z } from "zod";
import type { StreamEvent } from "./events";

/**
 * Contracts for the in-VM Codex SDK runner.
 *
 * The runner is a small Node script executed inside the microVM that drives the
 * official @openai/codex-sdk and prints one protocol line per SDK event to
 * stdout, prefixed with "CW1 ". The server side parses those lines and maps the
 * raw SDK events onto our StreamEvent union so the UI and task logs stay in
 * domain terms regardless of harness internals.
 *
 * Raw SDK shapes below mirror @openai/codex-sdk (verified against its source,
 * v0.164.0): thread.started / turn.started / turn.completed / turn.failed /
 * item.started / item.updated / item.completed / error.
 */

// ---------------------------------------------------------------------------
// Raw SDK wire schemas (only the fields we consume; unknown extras tolerated)
// ---------------------------------------------------------------------------

export const CodexSdkUsageSchema = z.object({
  input_tokens: z.number().nonnegative(),
  cached_input_tokens: z.number().nonnegative().optional(),
  cache_write_input_tokens: z.number().nonnegative().optional(),
  output_tokens: z.number().nonnegative(),
  reasoning_output_tokens: z.number().nonnegative().optional(),
});

export type CodexSdkUsage = z.infer<typeof CodexSdkUsageSchema>;

export const CodexSdkCommandExecutionItemSchema = z.object({
  id: z.string(),
  type: z.literal("command_execution"),
  command: z.string(),
  aggregated_output: z.string().optional(),
  exit_code: z.number().int().optional(),
  status: z.enum(["in_progress", "completed", "failed"]),
});

export const CodexSdkFileChangeItemSchema = z.object({
  id: z.string(),
  type: z.literal("file_change"),
  changes: z
    .array(
      z.object({
        path: z.string(),
        kind: z.enum(["add", "delete", "update"]),
      }),
    )
    .optional(),
  status: z.enum(["completed", "failed"]).optional(),
});

export const CodexSdkAgentMessageItemSchema = z.object({
  id: z.string(),
  type: z.literal("agent_message"),
  text: z.string(),
});

export const CodexSdkReasoningItemSchema = z.object({
  id: z.string(),
  type: z.literal("reasoning"),
  text: z.string().optional(),
});

export const CodexSdkErrorItemSchema = z.object({
  id: z.string(),
  type: z.literal("error"),
  message: z.string(),
});

/**
 * Any other item kind (mcp_tool_call, web_search, todo_list, or future types).
 * We accept and ignore them so harness updates never break the pipeline.
 */
export const CodexSdkOpaqueItemSchema = z.object({
  id: z.string().optional(),
  type: z.string(),
});

// ---------------------------------------------------------------------------
// Runner protocol envelope (one JSON object per "CW1 " stdout line)
// ---------------------------------------------------------------------------

export const CodexRunnerLineSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("ready"),
    sdk: z.string(),
    node: z.string().optional(),
    resumed: z.boolean().optional(),
  }),
  z.object({
    t: z.literal("thread"),
    id: z.string(),
    resumed: z.boolean(),
  }),
  z.object({
    t: z.literal("ev"),
    e: z.unknown(),
  }),
  z.object({
    t: z.literal("log"),
    m: z.string(),
  }),
  z.object({
    t: z.literal("result"),
    code: z.number().int(),
    usage: CodexSdkUsageSchema.nullable().optional(),
    final: z.string().optional(),
    error: z.string().optional(),
  }),
]);

export type CodexRunnerLine = z.infer<typeof CodexRunnerLineSchema>;

export const CODEX_RUNNER_PREFIX = "CW1 ";

/**
 * Parses one raw stdout line from the runner (with or without the CW1 prefix).
 * Returns null for anything that is not a valid protocol line so callers can
 * fall through to plain terminal output handling.
 */
export function parseCodexRunnerLine(line: string): CodexRunnerLine | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith(CODEX_RUNNER_PREFIX.trim())) {
    return null;
  }
  const jsonText = trimmed.slice(CODEX_RUNNER_PREFIX.trim().length).trim();
  if (!jsonText.startsWith("{")) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  const result = CodexRunnerLineSchema.safeParse(parsed);
  if (!result.success) {
    return null;
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// SDK event -> StreamEvent mapping
// ---------------------------------------------------------------------------

export interface CodexSdkUsageSummary {
  inputTokens: number;
  cachedInputTokens?: number;
  outputTokens: number;
  totalTokens: number;
}

export function summarizeCodexUsage(usage: CodexSdkUsage): CodexSdkUsageSummary {
  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;
  return {
    inputTokens,
    cachedInputTokens: usage.cached_input_tokens ?? 0,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

/**
 * Maps one raw @openai/codex-sdk thread event onto zero or more StreamEvents.
 * Unknown event or item types map to nothing, never to an error — the stream
 * must survive harness version drift.
 *
 * Mapping summary:
 * - reasoning (completed)          -> thought
 * - agent_message (completed)      -> agent_message
 * - command_execution started      -> tool_call (bash)
 * - command_execution completed    -> tool_result (exit code, output)
 * - file_change completed          -> tool_call (write_file) per changed file
 * - turn.completed                 -> usage (real token counts)
 */
export function mapCodexSdkEvent(raw: unknown, taskId: string, timestamp: number = Date.now()): StreamEvent[] {
  if (typeof raw !== "object" || raw === null) {
    return [];
  }
  const event = raw as Record<string, unknown>;
  const type = event.type;

  if (type === "item.started") {
    const item = CodexSdkCommandExecutionItemSchema.safeParse(event.item);
    if (item.success) {
      return [
        {
          type: "tool_call",
          taskId,
          callId: item.data.id,
          tool: "bash",
          args: { command: item.data.command },
          timestamp,
        },
      ];
    }
    return [];
  }

  if (type === "item.completed") {
    const item = event.item;
    if (typeof item !== "object" || item === null) {
      return [];
    }
    const itemType = (item as Record<string, unknown>).type;

    if (itemType === "reasoning") {
      const parsed = CodexSdkReasoningItemSchema.safeParse(item);
      const text = parsed.success ? (parsed.data.text ?? "").trim() : "";
      if (!text) return [];
      return [{ type: "thought", taskId, thought: text, timestamp }];
    }

    if (itemType === "agent_message") {
      const parsed = CodexSdkAgentMessageItemSchema.safeParse(item);
      if (!parsed.success) return [];
      return [{ type: "agent_message", taskId, message: parsed.data.text, timestamp }];
    }

    if (itemType === "command_execution") {
      const parsed = CodexSdkCommandExecutionItemSchema.safeParse(item);
      if (!parsed.success) return [];
      const failed = parsed.data.status === "failed";
      return [
        {
          type: "tool_result",
          taskId,
          callId: parsed.data.id,
          tool: "bash",
          output: parsed.data.aggregated_output ?? "",
          exitCode: parsed.data.exit_code ?? (failed ? 1 : 0),
          isError: failed,
          timestamp,
        },
      ];
    }

    if (itemType === "file_change") {
      const parsed = CodexSdkFileChangeItemSchema.safeParse(item);
      if (!parsed.success) return [];
      const changes = parsed.data.changes ?? [];
      const events: StreamEvent[] = changes.map((change, index) => ({
        type: "tool_call" as const,
        taskId,
        callId: `${parsed.data.id}:${index}`,
        tool: "write_file" as const,
        args: { path: change.path, change: change.kind },
        timestamp,
      }));
      if (parsed.data.status === "failed" && changes.length > 0) {
        events.push({
          type: "tool_result",
          taskId,
          callId: `${parsed.data.id}:0`,
          tool: "write_file",
          output: "patch apply failed",
          exitCode: 1,
          isError: true,
          timestamp,
        });
      }
      return events;
    }

    return [];
  }

  if (type === "turn.completed") {
    const parsed = CodexSdkUsageSchema.safeParse(event.usage);
    if (!parsed.success) return [];
    const summary = summarizeCodexUsage(parsed.data);
    return [
      {
        type: "usage",
        taskId,
        inputTokens: summary.inputTokens,
        cachedInputTokens: summary.cachedInputTokens,
        outputTokens: summary.outputTokens,
        totalTokens: summary.totalTokens,
        timestamp,
      },
    ];
  }

  // thread.started / turn.started / item.updated / turn.failed / error are
  // handled by the runner envelope or the terminal error path.
  return [];
}
