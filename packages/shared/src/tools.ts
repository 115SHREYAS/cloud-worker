import { z } from "zod";

export const BashToolInputSchema = z.object({
  command: z.string().describe("The bash command to execute in the workspace"),
  cwd: z.string().optional().describe("Working directory relative to /workspace"),
  timeoutMs: z.number().int().positive().optional().describe("Timeout in milliseconds"),
});

export type BashToolInput = z.infer<typeof BashToolInputSchema>;

export const ReadFileToolInputSchema = z.object({
  path: z.string().describe("File path relative to /workspace"),
  startLine: z.number().int().positive().optional().describe("Start line (1-indexed)"),
  endLine: z.number().int().positive().optional().describe("End line (1-indexed, inclusive)"),
});

export type ReadFileToolInput = z.infer<typeof ReadFileToolInputSchema>;

export const WriteFileToolInputSchema = z.object({
  path: z.string().describe("File path relative to /workspace"),
  content: z.string().describe("Complete file content to write"),
});

export type WriteFileToolInput = z.infer<typeof WriteFileToolInputSchema>;

export const ListDirToolInputSchema = z.object({
  path: z.string().optional().default(".").describe("Directory path relative to /workspace"),
  recursive: z.boolean().optional().default(false).describe("Whether to list recursively"),
});

export type ListDirToolInput = z.infer<typeof ListDirToolInputSchema>;

export const GitDiffToolInputSchema = z.object({
  staged: z.boolean().optional().default(false).describe("Show only staged changes"),
});

export type GitDiffToolInput = z.infer<typeof GitDiffToolInputSchema>;

export const AgentToolNameSchema = z.enum([
  "bash",
  "read_file",
  "write_file",
  "list_dir",
  "git_diff",
]);

export type AgentToolName = z.infer<typeof AgentToolNameSchema>;

export interface AnthropicToolDefinition {
  name: AgentToolName;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const AGENT_TOOLS: readonly AnthropicToolDefinition[] = [
  {
    name: "bash",
    description: "Execute a bash command in the workspace microVM. Use for running tests, linters, installs, and builds.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The bash command to execute" },
        cwd: { type: "string", description: "Working directory relative to /workspace" },
        timeoutMs: { type: "number", description: "Execution timeout in milliseconds" },
      },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read contents of a file in the repository workspace.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to /workspace" },
        startLine: { type: "number", description: "Start line number (1-indexed)" },
        endLine: { type: "number", description: "End line number (1-indexed, inclusive)" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write full contents to a file in the workspace. Creates directories if needed.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to /workspace" },
        content: { type: "string", description: "Full text content to write" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "list_dir",
    description: "List directory contents in the workspace.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path relative to /workspace (defaults to .)" },
        recursive: { type: "boolean", description: "Whether to list recursively" },
      },
    },
  },
  {
    name: "git_diff",
    description: "Inspect unstaged or staged git diff in the repository.",
    input_schema: {
      type: "object",
      properties: {
        staged: { type: "boolean", description: "Whether to view staged changes only" },
      },
    },
  },
] as const;
