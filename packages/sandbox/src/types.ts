import type { CommandExecutionResult, FileEntry } from "@cloud-worker/shared";

export interface SandboxManagerConfig {
  template?: string;
  templateId?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  envs?: Record<string, string>;
  apiKey?: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputChars?: number;
  onStdout?: (chunk: string) => void | Promise<void>;
  onStderr?: (chunk: string) => void | Promise<void>;
}

export interface ReadFileOptions {
  startLine?: number;
  endLine?: number;
}

export interface WorkspaceInitResult {
  workspacePath: string;
  tools: {
    git?: string;
    node?: string;
    npm?: string;
    python?: string;
  };
}

export type { CommandExecutionResult, FileEntry };
