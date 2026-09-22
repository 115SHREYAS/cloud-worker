import { z } from "zod";
import { TaskStatusSchema, TokenUsageSchema } from "./task";
import { AgentToolNameSchema, type AgentToolName } from "./tools";

export const LogChunkStdoutEventSchema = z.object({
  type: z.literal("stdout"),
  taskId: z.string(),
  data: z.string(),
  timestamp: z.number(),
});

export type LogChunkStdoutEvent = z.infer<typeof LogChunkStdoutEventSchema>;

export const LogChunkStderrEventSchema = z.object({
  type: z.literal("stderr"),
  taskId: z.string(),
  data: z.string(),
  timestamp: z.number(),
});

export type LogChunkStderrEvent = z.infer<typeof LogChunkStderrEventSchema>;

export const AgentThoughtEventSchema = z.object({
  type: z.literal("thought"),
  taskId: z.string(),
  thought: z.string(),
  timestamp: z.number(),
});

export type AgentThoughtEvent = z.infer<typeof AgentThoughtEventSchema>;

export const AgentToolCallEventSchema = z.object({
  type: z.literal("tool_call"),
  taskId: z.string(),
  callId: z.string(),
  tool: AgentToolNameSchema,
  args: z.record(z.string(), z.unknown()),
  timestamp: z.number(),
});

export type AgentToolCallEvent = z.infer<typeof AgentToolCallEventSchema>;

export const AgentToolResultEventSchema = z.object({
  type: z.literal("tool_result"),
  taskId: z.string(),
  callId: z.string(),
  tool: AgentToolNameSchema,
  output: z.string(),
  exitCode: z.number().optional(),
  isError: z.boolean().default(false),
  timestamp: z.number(),
});

export type AgentToolResultEvent = z.infer<typeof AgentToolResultEventSchema>;

export const GitDiffEventSchema = z.object({
  type: z.literal("diff"),
  taskId: z.string(),
  diff: z.string(),
  timestamp: z.number(),
});

export type GitDiffEvent = z.infer<typeof GitDiffEventSchema>;

export const TaskStatusEventSchema = z.object({
  type: z.literal("status"),
  taskId: z.string(),
  status: TaskStatusSchema,
  message: z.string().optional(),
  timestamp: z.number(),
});

export type TaskStatusEvent = z.infer<typeof TaskStatusEventSchema>;

export const TaskDoneEventSchema = z.object({
  type: z.literal("done"),
  taskId: z.string(),
  pullRequestUrl: z.string().url().optional(),
  summary: z.string().optional(),
  tokenUsage: TokenUsageSchema.optional(),
  timestamp: z.number(),
});

export type TaskDoneEvent = z.infer<typeof TaskDoneEventSchema>;

export const TaskErrorEventSchema = z.object({
  type: z.literal("error"),
  taskId: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
  timestamp: z.number(),
});

export type TaskErrorEvent = z.infer<typeof TaskErrorEventSchema>;

export const PingEventSchema = z.object({
  type: z.literal("ping"),
  timestamp: z.number(),
});

export type PingEvent = z.infer<typeof PingEventSchema>;

export const StreamEventSchema = z.discriminatedUnion("type", [
  LogChunkStdoutEventSchema,
  LogChunkStderrEventSchema,
  AgentThoughtEventSchema,
  AgentToolCallEventSchema,
  AgentToolResultEventSchema,
  GitDiffEventSchema,
  TaskStatusEventSchema,
  TaskDoneEventSchema,
  TaskErrorEventSchema,
  PingEventSchema,
]);

export type StreamEvent = z.infer<typeof StreamEventSchema>;

export function getTaskChannel(taskId: string): string {
  return `task:${taskId}:events`;
}
