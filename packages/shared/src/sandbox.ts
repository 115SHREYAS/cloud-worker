import { z } from "zod";

export const CommandExecutionInputSchema = z.object({
  command: z.string().min(1, "Command must not be empty"),
  cwd: z.string().default("/workspace"),
  env: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().positive().default(120_000),
});

export type CommandExecutionInput = z.infer<typeof CommandExecutionInputSchema>;

export const CommandExecutionResultSchema = z.object({
  exitCode: z.number().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number(),
});

export type CommandExecutionResult = z.infer<typeof CommandExecutionResultSchema>;

export const FileEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  isDirectory: z.boolean(),
  size: z.number().int().nonnegative().optional(),
});

export type FileEntry = z.infer<typeof FileEntrySchema>;

export const FileReadInputSchema = z.object({
  path: z.string().min(1, "Path is required"),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
});

export type FileReadInput = z.infer<typeof FileReadInputSchema>;

export const FileWriteInputSchema = z.object({
  path: z.string().min(1, "Path is required"),
  content: z.string(),
});

export type FileWriteInput = z.infer<typeof FileWriteInputSchema>;

export const SandboxStatusSchema = z.enum([
  "starting",
  "ready",
  "busy",
  "stopped",
  "error",
]);

export type SandboxStatus = z.infer<typeof SandboxStatusSchema>;

export const SandboxConfigSchema = z.object({
  templateId: z.string().optional(),
  timeoutMs: z.number().int().positive().default(900_000), // 15 minutes default TTL
  env: z.record(z.string(), z.string()).optional(),
});

export type SandboxConfig = z.infer<typeof SandboxConfigSchema>;
