import { z } from "zod";
import type { StreamEvent } from "./events";
import type { AgentToolName } from "./tools";

/**
 * Contracts for the in-VM Claude Agent SDK runner.
 *
 * The runner is a Node ESM script executed inside the microVM that drives the
 * official @anthropic-ai/claude-agent-sdk and prints one protocol line per SDK
 * message to stdout, prefixed with "CW1 ". The control plane parses those lines
 * and maps raw SDK messages onto our StreamEvent union.
 */

// ---------------------------------------------------------------------------
// Raw SDK wire schemas (only the fields we consume; unknown extras tolerated)
// ---------------------------------------------------------------------------

export const ClaudeSdkUsageSchema = z.object({
  input_tokens: z.number().nonnegative(),
  output_tokens: z.number().nonnegative(),
  cache_creation_input_tokens: z.number().nonnegative().optional(),
  cache_read_input_tokens: z.number().nonnegative().optional(),
});

export type ClaudeSdkUsage = z.infer<typeof ClaudeSdkUsageSchema>;

export const ClaudeSdkModelUsageSchema = z.object({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  thinkingTokens: z.number().nonnegative().optional(),
  cacheReadInputTokens: z.number().nonnegative().optional(),
  cacheCreationInputTokens: z.number().nonnegative().optional(),
});

export type ClaudeSdkModelUsage = z.infer<typeof ClaudeSdkModelUsageSchema>;

export const ClaudeSdkThinkingBlockSchema = z.object({
  type: z.literal("thinking"),
  thinking: z.string(),
  signature: z.string().optional(),
});

export const ClaudeSdkTextBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

export const ClaudeSdkToolUseBlockSchema = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()).optional().default({}),
});

export const ClaudeSdkToolResultBlockSchema = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: z.unknown().optional(),
  is_error: z.boolean().optional(),
});

export const ClaudeSdkAssistantMessageSchema = z.object({
  type: z.literal("assistant"),
  session_id: z.string().optional(),
  parent_tool_use_id: z.string().nullable().optional(),
  message: z
    .object({
      id: z.string().optional(),
      model: z.string().optional(),
      content: z.array(z.record(z.string(), z.unknown())).optional().default([]),
      stop_reason: z.string().nullable().optional(),
    })
    .optional(),
});

export const ClaudeSdkUserMessageSchema = z.object({
  type: z.literal("user"),
  session_id: z.string().optional(),
  parent_tool_use_id: z.string().nullable().optional(),
  message: z
    .object({
      role: z.literal("user").optional(),
      content: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]).optional(),
    })
    .optional(),
  tool_use_result: z.unknown().optional(),
});

export const ClaudeSdkResultMessageSchema = z.object({
  type: z.literal("result"),
  subtype: z.string().optional(),
  duration_ms: z.number().optional(),
  duration_api_ms: z.number().optional(),
  is_error: z.boolean().optional(),
  num_turns: z.number().optional(),
  stop_reason: z.string().nullable().optional(),
  total_cost_usd: z.number().optional(),
  usage: ClaudeSdkUsageSchema.optional(),
  modelUsage: z.record(z.string(), ClaudeSdkModelUsageSchema).optional(),
  result: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Runner protocol envelope (one JSON object per "CW1 " stdout line)
// ---------------------------------------------------------------------------

export const ClaudeRunnerLineSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("ready"),
    sdk: z.string(),
    node: z.string().optional(),
    resumed: z.boolean().optional(),
  }),
  z.object({
    t: z.literal("session"),
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
    usage: ClaudeSdkUsageSchema.nullable().optional(),
    modelUsage: z.record(z.string(), ClaudeSdkModelUsageSchema).optional(),
    totalCostUsd: z.number().optional(),
    final: z.string().optional(),
    error: z.string().optional(),
  }),
]);

export type ClaudeRunnerLine = z.infer<typeof ClaudeRunnerLineSchema>;

export const CLAUDE_RUNNER_PREFIX = "CW1 ";

/**
 * Parses one raw stdout line from the runner (with or without the CW1 prefix).
 * Returns null for anything that is not a valid protocol line.
 */
export function parseClaudeRunnerLine(line: string): ClaudeRunnerLine | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith(CLAUDE_RUNNER_PREFIX.trim())) {
    return null;
  }
  const jsonText = trimmed.slice(CLAUDE_RUNNER_PREFIX.trim().length).trim();
  if (!jsonText.startsWith("{")) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  const result = ClaudeRunnerLineSchema.safeParse(parsed);
  if (!result.success) {
    return null;
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// SDK event -> StreamEvent mapping
// ---------------------------------------------------------------------------

export interface ClaudeSdkUsageSummary {
  inputTokens: number;
  cachedInputTokens?: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd?: number;
}

export function summarizeClaudeUsage(
  usage: ClaudeSdkUsage | ClaudeSdkModelUsage,
  costUsd?: number,
): ClaudeSdkUsageSummary {
  if ("input_tokens" in usage) {
    const inputTokens = usage.input_tokens;
    const outputTokens = usage.output_tokens;
    const cachedInputTokens =
      (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    return {
      inputTokens,
      cachedInputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      estimatedCostUsd: costUsd,
    };
  }

  const inputTokens = usage.inputTokens;
  const outputTokens = usage.outputTokens;
  const cachedInputTokens =
    (usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0);
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimatedCostUsd: costUsd,
  };
}

/**
 * Normalizes tool names from Claude SDK tool names (e.g. Bash, Read, Edit)
 * into Cloud Worker's canonical AgentToolName set.
 */
export function mapClaudeToolName(rawName: string): AgentToolName | null {
  const lower = rawName.toLowerCase();
  if (lower === "bash" || lower === "sh" || lower === "command") {
    return "bash";
  }
  if (lower === "read" || lower === "view" || lower === "read_file") {
    return "read_file";
  }
  if (
    lower === "write" ||
    lower === "edit" ||
    lower === "multiedit" ||
    lower === "write_file"
  ) {
    return "write_file";
  }
  if (lower === "glob" || lower === "ls" || lower === "list_dir") {
    return "list_dir";
  }
  if (lower === "gitdiff" || lower === "git_diff") {
    return "git_diff";
  }
  // Grep or search tools map cleanly to bash command or read_file context
  if (lower === "grep") {
    return "bash";
  }
  return null;
}

/**
 * Extracts a human-readable string representation from a tool result content block.
 */
function extractToolResultString(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && "text" in item && typeof item.text === "string") {
          return item.text;
        }
        return JSON.stringify(item);
      })
      .join("\n");
  }
  if (content !== undefined && content !== null) {
    return JSON.stringify(content);
  }
  return "";
}

/**
 * Maps one raw @anthropic-ai/claude-agent-sdk message onto zero or more StreamEvents.
 * Unknown message or block kinds map to nothing, never throwing.
 */
export function mapClaudeSdkEvent(
  raw: unknown,
  taskId: string,
  timestamp: number = Date.now(),
): StreamEvent[] {
  if (typeof raw !== "object" || raw === null) {
    return [];
  }
  const msg = raw as Record<string, unknown>;
  const type = msg.type;

  // 1. Assistant message: thinking blocks, text blocks, tool_use blocks
  if (type === "assistant") {
    const assistant = ClaudeSdkAssistantMessageSchema.safeParse(msg);
    if (!assistant.success || !assistant.data.message?.content) {
      return [];
    }

    const events: StreamEvent[] = [];
    for (const block of assistant.data.message.content) {
      const blockType = block.type;

      if (blockType === "thinking") {
        const thinkingBlock = ClaudeSdkThinkingBlockSchema.safeParse(block);
        if (thinkingBlock.success && thinkingBlock.data.thinking.trim()) {
          events.push({
            type: "thought",
            taskId,
            thought: thinkingBlock.data.thinking,
            timestamp,
          });
        }
      } else if (blockType === "tool_use") {
        const toolUseBlock = ClaudeSdkToolUseBlockSchema.safeParse(block);
        if (toolUseBlock.success) {
          const mappedTool = mapClaudeToolName(toolUseBlock.data.name) || "bash";
          const input = toolUseBlock.data.input || {};

          let args: Record<string, unknown> = input;
          if (mappedTool === "bash" && !("command" in input)) {
            // If grep or another tool mapped to bash, construct command
            if (toolUseBlock.data.name.toLowerCase() === "grep" && typeof input.pattern === "string") {
              args = { command: `grep -r "${input.pattern}" ${input.path || "."}` };
            }
          } else if (mappedTool === "read_file" && !("path" in input)) {
            args = { path: input.file_path || input.path || "" };
          } else if (mappedTool === "write_file" && !("path" in input)) {
            args = { path: input.file_path || input.path || "", content: input.content || "" };
          }

          events.push({
            type: "tool_call",
            taskId,
            callId: toolUseBlock.data.id,
            tool: mappedTool,
            args,
            timestamp,
          });
        }
      } else if (blockType === "text") {
        const textBlock = ClaudeSdkTextBlockSchema.safeParse(block);
        if (textBlock.success && textBlock.data.text.trim()) {
          events.push({
            type: "agent_message",
            taskId,
            message: textBlock.data.text.trim(),
            timestamp,
          });
        }
      }
    }
    return events;
  }

  // 2. User message: tool_result blocks answering tool_use
  if (type === "user") {
    const user = ClaudeSdkUserMessageSchema.safeParse(msg);
    if (!user.success) {
      return [];
    }

    const content = user.data.message?.content;
    if (Array.isArray(content)) {
      const events: StreamEvent[] = [];
      for (const item of content) {
        if (typeof item === "object" && item !== null && item.type === "tool_result") {
          const toolResult = ClaudeSdkToolResultBlockSchema.safeParse(item);
          if (toolResult.success) {
            const outputText = extractToolResultString(toolResult.data.content);
            const isError = Boolean(toolResult.data.is_error);
            events.push({
              type: "tool_result",
              taskId,
              callId: toolResult.data.tool_use_id,
              tool: "bash", // default fallback tool classification
              output: outputText,
              exitCode: isError ? 1 : 0,
              isError,
              timestamp,
            });
          }
        }
      }
      return events;
    }
    return [];
  }

  // 3. Result message: token usage & summary
  if (type === "result") {
    const result = ClaudeSdkResultMessageSchema.safeParse(msg);
    if (!result.success) {
      return [];
    }

    const events: StreamEvent[] = [];

    // Prioritize modelUsage if available, else usage
    let summary: ClaudeSdkUsageSummary | null = null;
    let modelName: string | undefined;

    if (result.data.modelUsage) {
      const entries = Object.entries(result.data.modelUsage);
      if (entries.length > 0) {
        modelName = entries[0]?.[0];
        const primary = entries[0]?.[1];
        if (primary) {
          summary = summarizeClaudeUsage(primary, result.data.total_cost_usd);
        }
      }
    }

    if (!summary && result.data.usage) {
      summary = summarizeClaudeUsage(result.data.usage, result.data.total_cost_usd);
    }

    if (summary) {
      events.push({
        type: "usage",
        taskId,
        inputTokens: summary.inputTokens,
        cachedInputTokens: summary.cachedInputTokens,
        outputTokens: summary.outputTokens,
        totalTokens: summary.totalTokens,
        model: modelName,
        timestamp,
      });
    }

    // Final result text if present and non-empty
    if (result.data.result && result.data.result.trim()) {
      events.push({
        type: "agent_message",
        taskId,
        message: result.data.result.trim(),
        timestamp,
      });
    }

    return events;
  }

  return [];
}
