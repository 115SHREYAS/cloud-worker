import type { CommandExecutionResult, FileEntry } from "@cloud-worker/shared";

export type AgentProvider = "codex" | "claude";

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
  firewallConfigured?: boolean;
  tools: {
    git?: string;
    node?: string;
    npm?: string;
    python?: string;
  };
}


export interface AgentSessionConfig {
  provider?: AgentProvider;
  authJson?: string;
  apiKey?: string;
  githubToken?: string;
  workingBranch?: string;
  baseBranch?: string;
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void | Promise<void>;
  onStderr?: (chunk: string) => void | Promise<void>;
}

export interface AgentSessionResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  diff: string;
  durationMs: number;
  refreshedAuthJson?: string;
}

export type { CommandExecutionResult, FileEntry };
