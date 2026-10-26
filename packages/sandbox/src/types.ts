import type { CommandExecutionResult, CodexSdkUsageSummary, FileEntry, StreamEvent } from "@cloud-worker/shared";

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


export interface AgentRunOptions {
  isContinue?: boolean;
}

export interface AgentSessionConfig {
  provider?: AgentProvider;
  model?: string;
  reasoningEffort?: "none" | "low" | "medium" | "high";
  authJson?: string;
  apiKey?: string;
  githubToken?: string;
  workingBranch?: string;
  baseBranch?: string;
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  isContinue?: boolean;
  /** Owning task id, used to stamp structured events emitted by SDK-backed runs. */
  taskId?: string;
  onStdout?: (chunk: string) => void | Promise<void>;
  onStderr?: (chunk: string) => void | Promise<void>;
  /** Receives structured StreamEvents mapped from Codex SDK thread events. */
  onEvent?: (events: StreamEvent[]) => void | Promise<void>;
}

export interface AgentSessionResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  diff: string;
  durationMs: number;
  refreshedAuthJson?: string;
  /** Real token usage reported by the Codex SDK on the final turn (undefined for CLI runs). */
  sdkUsage?: CodexSdkUsageSummary;
  /** Final agent message text reported by the Codex SDK for the turn. */
  finalMessage?: string;
}

export type { CommandExecutionResult, FileEntry };
