import type { SandboxManager } from "./sandbox";
import type {
  AgentSessionConfig,
  AgentSessionResult,
  AgentProvider,
  AgentRunOptions,
  CommandExecutionResult,
} from "./types";
import type { CodexRunnerLine, CodexSdkUsageSummary } from "@cloud-worker/shared";
import { parseCodexRunnerLine, mapCodexSdkEvent, summarizeCodexUsage } from "@cloud-worker/shared";
import {
  ensureCodexSdkRunner,
  CODEX_RUNNER_SCRIPT,
  CODEX_THREAD_FILE,
} from "./codex-runner-setup";

type CodexRunnerResultLine = Extract<CodexRunnerLine, { t: "result" }>;

export class AgentSession {
  private codexSdkReady: boolean | null = null;

  private constructor(
    public readonly sandbox: SandboxManager,
    public readonly config: AgentSessionConfig,
  ) {}

  public static create(
    sandbox: SandboxManager,
    config: AgentSessionConfig = {},
  ): AgentSession {
    return new AgentSession(sandbox, config);
  }

  /**
   * Prepares credentials, ensures the harness is available, and executes the
   * agent prompt inside /workspace. Codex runs through the official
   * @openai/codex-sdk runner (structured events + real token usage) and falls
   * back to the raw CLI when the SDK cannot be installed in the microVM.
   */
  public async run(prompt: string, runOptions?: AgentRunOptions): Promise<AgentSessionResult> {
    const provider: AgentProvider = this.config.provider ?? "codex";
    const cwd = this.config.cwd ?? "/workspace";
    const timeoutMs = this.config.timeoutMs ?? 600_000; // 10 minutes default
    const startTime = Date.now();
    const isContinue = runOptions?.isContinue ?? this.config.isContinue ?? false;

    // 1. Inject subscription authentication or API key
    await this.injectAuth(provider);

    // 2. Ensure a harness is available: SDK runner for codex, global CLI otherwise
    const useCodexSdk = provider === "codex" ? await this.ensureCodexSdk() : false;
    if (!useCodexSdk) {
      await this.ensureCli(provider);
    }

    // 3. Record baseline git commit & set up working branch if specified
    const startCommit = await this.getCurrentCommit(cwd);
    if (this.config.workingBranch) {
      await this.setupWorkingBranch(this.config.workingBranch, cwd);
    }

    // 4. Safely store prompt in /tmp to avoid polluting /workspace git status
    const promptId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const promptFilePath = `/tmp/.agent-prompt-${promptId}.txt`;
    const promptWithGuideline = `${prompt.trim()}\n\n---\nWorkflow note: When your changes are complete, please write a single-line conventional commit message summarizing the changes (e.g. "feat(auth): add token refresh support") into /tmp/.pr_title`;
    await this.sandbox.writeFile(promptFilePath, promptWithGuideline);

    let execResult: { exitCode: number | null; stdout: string; stderr: string };
    let refreshedAuthJson: string | undefined;
    let sdkResultLine: CodexRunnerResultLine | null = null;

    // Handle abort signal if task cancellation is requested
    let abortListener: (() => void) | undefined;
    if (this.config.signal) {
      abortListener = () => {
        // When cancelled, kill any running processes in the VM
        this.sandbox.exec("pkill -9 -f 'codex|claude' || true").catch(() => {});
      };
      this.config.signal.addEventListener("abort", abortListener, { once: true });
    }

    try {
      let res: CommandExecutionResult;
      let cliFallbackUsed = false;

      if (useCodexSdk) {
        // 5a. Run through the in-VM Codex SDK runner with structured event relay
        const sdk = this.buildCodexSdkCommand(promptFilePath, isContinue);
        const lineHandler = this.createCodexRunnerLineHandler();
        res = await this.sandbox.exec(sdk.command, {
          cwd,
          env: sdk.env,
          timeoutMs,
          onStdout: lineHandler.onStdout,
          onStderr: this.config.onStderr,
        });
        await lineHandler.flush();
        sdkResultLine = lineHandler.result;

        // The runner could not use the SDK after all — fall back to the raw CLI
        if (sdkResultLine?.code === 2) {
          console.warn("[agent-session] Codex SDK runner unavailable, falling back to raw CLI execution");
          await this.ensureCli(provider);
          const cli = this.buildRunCommand(provider, promptFilePath, false);
          res = await this.sandbox.exec(cli.command, {
            cwd,
            env: cli.env,
            timeoutMs,
            onStdout: this.config.onStdout,
            onStderr: this.config.onStderr,
          });
          sdkResultLine = null;
          cliFallbackUsed = true;
        }

        execResult = {
          exitCode: res.exitCode,
          stdout: res.stdout,
          stderr:
            !cliFallbackUsed && sdkResultLine?.error
              ? `${res.stderr}\n[codex-sdk] ${sdkResultLine.error}`.trim()
              : res.stderr,
        };
      } else {
        // 5b. Raw CLI execution with stdout parsing (claude, or codex fallback)
        const { command, env } = this.buildRunCommand(provider, promptFilePath, isContinue);

        res = await this.sandbox.exec(command, {
          cwd,
          env,
          timeoutMs,
          onStdout: this.config.onStdout,
          onStderr: this.config.onStderr,
        });

        // Graceful fallback if resume failed because no previous session was found
        if (
          isContinue &&
          res.exitCode !== 0 &&
          (res.stderr.toLowerCase().includes("no session") ||
            res.stderr.toLowerCase().includes("could not find session") ||
            res.stderr.toLowerCase().includes("no previous"))
        ) {
          console.warn(`[agent-session] Session resume failed, starting fresh session: ${res.stderr.trim()}`);
          const fresh = this.buildRunCommand(provider, promptFilePath, false);
          res = await this.sandbox.exec(fresh.command, {
            cwd,
            env: fresh.env,
            timeoutMs,
            onStdout: this.config.onStdout,
            onStderr: this.config.onStderr,
          });
        }

        execResult = {
          exitCode: res.exitCode,
          stdout: res.stdout,
          stderr: res.stderr,
        };
      }
    } finally {
      // Clean up abort listener
      if (this.config.signal && abortListener) {
        this.config.signal.removeEventListener("abort", abortListener);
      }

      // Always clean up temporary prompt file
      try {
        await this.sandbox.exec(`rm -f "${promptFilePath}"`);
      } catch {
        // Ignore cleanup error
      }

      // Always capture refreshed auth credentials even if run failed or timed out
      refreshedAuthJson = await this.captureRefreshedAuth(provider);
    }

    // 7. Capture complete git diff (including commits made by the agent)
    const diff = await this.captureFullDiff(cwd, startCommit);

    const sdkUsage: CodexSdkUsageSummary | undefined =
      sdkResultLine && sdkResultLine.usage
        ? summarizeCodexUsage(sdkResultLine.usage)
        : undefined;

    return {
      exitCode: execResult.exitCode,
      stdout: execResult.stdout,
      stderr: execResult.stderr,
      diff,
      durationMs: Date.now() - startTime,
      refreshedAuthJson,
      sdkUsage,
      finalMessage: sdkResultLine?.final,
    };
  }

  private async ensureCodexSdk(): Promise<boolean> {
    if (this.codexSdkReady === null) {
      this.codexSdkReady = await ensureCodexSdkRunner(this.sandbox).catch((err) => {
        console.warn("[agent-session] Codex SDK runner setup failed:", err);
        return false;
      });
    }
    return this.codexSdkReady;
  }

  /**
   * Streams the SDK runner's stdout line by line: CW1 protocol lines are
   * decoded into structured StreamEvents, while anything else (npm or node
   * noise) is forwarded to the plain stdout callback so the raw terminal
   * output stays honest without polluting it with protocol JSON.
   */
  private createCodexRunnerLineHandler() {
    let buffer = "";
    let result: CodexRunnerResultLine | null = null;

    const handleLine = async (line: string): Promise<boolean> => {
      const parsed = parseCodexRunnerLine(line);
      if (!parsed) {
        return false;
      }
      if (parsed.t === "ev") {
        if (this.config.taskId && this.config.onEvent) {
          const events = mapCodexSdkEvent(parsed.e, this.config.taskId);
          if (events.length > 0) {
            await this.config.onEvent(events);
          }
        }
      } else if (parsed.t === "result") {
        result = parsed;
      }
      // ready / thread / log lines are diagnostics; the worker emits its own status events
      return true;
    };

    return {
      get result(): CodexRunnerResultLine | null {
        return result;
      },
      onStdout: async (chunk: string) => {
        buffer += chunk;
        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          const handled = await handleLine(line);
          if (!handled && this.config.onStdout) {
            await this.config.onStdout(`${line}\n`);
          }
          newlineIndex = buffer.indexOf("\n");
        }
      },
      flush: async () => {
        if (buffer) {
          const remainder = buffer;
          buffer = "";
          const handled = await handleLine(remainder);
          if (!handled && this.config.onStdout) {
            await this.config.onStdout(remainder);
          }
        }
      },
    };
  }

  private buildCodexSdkCommand(
    promptFilePath: string,
    isContinue: boolean,
  ): { command: string; env: Record<string, string> } {
    const env: Record<string, string> = {
      CI: "1",
      NON_INTERACTIVE: "1",
      CW_PROMPT_FILE: promptFilePath,
      CW_THREAD_FILE: CODEX_THREAD_FILE,
      CW_CONTINUE: isContinue ? "1" : "0",
      CW_CWD: this.config.cwd ?? "/workspace",
      CODEX_HOME: "/home/user/.codex",
    };

    if (this.config.apiKey) {
      env.OPENAI_API_KEY = this.config.apiKey;
    }
    if (this.config.model && this.config.model !== "codex") {
      env.CW_MODEL = this.config.model;
    }
    if (
      this.config.reasoningEffort === "low" ||
      this.config.reasoningEffort === "medium" ||
      this.config.reasoningEffort === "high"
    ) {
      env.CW_EFFORT = this.config.reasoningEffort;
    }
    if (this.config.githubToken) {
      env.GITHUB_TOKEN = this.config.githubToken;
      env.GH_TOKEN = this.config.githubToken;
    }

    return {
      command: `node "${CODEX_RUNNER_SCRIPT}"`,
      env,
    };
  }

  private async injectAuth(provider: AgentProvider): Promise<void> {
    if (provider === "codex") {
      if (this.config.authJson) {
        const trimmed = this.config.authJson.trim();
        const content = trimmed.startsWith("{")
          ? trimmed
          : JSON.stringify({ token: trimmed, created_at: Date.now() }, null, 2);

        // Inject to /home/user/.codex/auth.json (primary for non-root E2B microVM environment)
        await this.sandbox.exec("mkdir -p /home/user/.codex");
        await this.sandbox.writeFile("/home/user/.codex/auth.json", content);
        await this.sandbox.exec("chmod 700 /home/user/.codex && chmod 600 /home/user/.codex/auth.json");

        // Also inject to /root/.codex/auth.json if writable
        try {
          await this.sandbox.exec("mkdir -p /root/.codex");
          await this.sandbox.writeFile("/root/.codex/auth.json", content);
          await this.sandbox.exec("chmod 600 /root/.codex/auth.json");
        } catch {
          // Ignore if running as non-root user
        }
      }
    } else if (provider === "claude") {
      if (this.config.authJson) {
        const trimmed = this.config.authJson.trim();
        let content: string;
        if (trimmed.startsWith("{")) {
          content = trimmed;
        } else {
          // If an official setup token (e.g. sk-ant-oat01-...) is provided, construct valid claude config
          const token = trimmed.replace(/^CLAUDE_CODE_OAUTH_TOKEN\s*=\s*/i, "").trim();
          content = JSON.stringify({ oauthToken: token }, null, 2);
        }

        // Inject to /home/user/.claude.json (primary for non-root E2B microVM environment)
        await this.sandbox.writeFile("/home/user/.claude.json", content);
        await this.sandbox.exec("chmod 600 /home/user/.claude.json");

        // Also inject to /root/.claude.json if writable
        try {
          await this.sandbox.writeFile("/root/.claude.json", content);
          await this.sandbox.exec("chmod 600 /root/.claude.json");
        } catch {
          // Ignore if running as non-root user
        }
      }
    }
  }

  private async ensureCli(provider: AgentProvider): Promise<void> {
    const binary = provider === "codex" ? "codex" : "claude";
    const check = await this.sandbox.exec(`which ${binary}`);

    if (check.exitCode === 0) {
      return;
    }

    // Install CLI globally inside the microVM
    const pkg = provider === "codex" ? "@openai/codex" : "@anthropic-ai/claude-code";
    const install = await this.sandbox.exec(`npm install -g ${pkg}`, {
      timeoutMs: 180_000,
    });

    if (install.exitCode !== 0) {
      throw new Error(`Failed to install ${pkg} inside microVM: ${install.stderr}`);
    }
  }

  private async getCurrentCommit(cwd: string): Promise<string | undefined> {
    const check = await this.sandbox.exec("git rev-parse HEAD", { cwd });
    return check.exitCode === 0 && check.stdout.trim() ? check.stdout.trim() : undefined;
  }

  private async setupWorkingBranch(branch: string, cwd: string): Promise<void> {
    if (!/^[a-zA-Z0-9._\-/]+$/.test(branch)) {
      throw new Error(`Invalid working branch name: "${branch}"`);
    }

    const checkGit = await this.sandbox.exec("git rev-parse --is-inside-work-tree", { cwd });
    if (checkGit.exitCode === 0) {
      const current = await this.sandbox.exec("git rev-parse --abbrev-ref HEAD", { cwd });
      if (current.stdout.trim() !== branch) {
        await this.sandbox.exec(`git checkout -B "${branch}"`, { cwd });
      }
    }
  }

  private buildRunCommand(
    provider: AgentProvider,
    promptFilePath: string,
    isContinue = false,
  ): { command: string; env: Record<string, string> } {
    const env: Record<string, string> = {
      CI: "1",
      NON_INTERACTIVE: "1",
    };

    if (provider === "codex") {
      env.CODEX_HOME = "/home/user/.codex";
    }

    if (this.config.apiKey) {
      if (provider === "codex") {
        env.OPENAI_API_KEY = this.config.apiKey;
      } else {
        env.ANTHROPIC_API_KEY = this.config.apiKey;
      }
    }

    // Inject Claude Code OAuth token into environment if provided as single-line token
    if (provider === "claude") {
      if (this.config.authJson) {
        const trimmed = this.config.authJson.trim();
        if (!trimmed.startsWith("{")) {
          env.CLAUDE_CODE_OAUTH_TOKEN = trimmed.replace(/^CLAUDE_CODE_OAUTH_TOKEN\s*=\s*/i, "").trim();
        }
      } else if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
        env.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
      }
    }

    if (this.config.githubToken) {
      env.GITHUB_TOKEN = this.config.githubToken;
      env.GH_TOKEN = this.config.githubToken;
    }

    if (provider === "codex") {
      // Non-interactive codex execution skipping confirmation prompts in the microVM
      const flags: string[] = ["--dangerously-bypass-approvals-and-sandbox"];

      if (this.config.model && this.config.model !== "codex" && this.config.model !== "claude") {
        flags.push(`-m "${this.config.model}"`);
      }

      if (this.config.reasoningEffort && this.config.reasoningEffort !== "none") {
        flags.push(`-c 'model_reasoning_effort="${this.config.reasoningEffort}"'`);
      }

      const subCmd = isContinue ? "exec resume --last" : "exec";
      return {
        command: `codex ${subCmd} ${flags.join(" ")} -- "$(cat "${promptFilePath}")"`,
        env,
      };
    } else {
      // Headless claude code execution skipping interactive permission prompts
      const flags: string[] = ["--dangerously-skip-permissions"];

      if (this.config.model && this.config.model !== "claude" && this.config.model !== "codex") {
        flags.push(`--model "${this.config.model}"`);
      }

      if (this.config.reasoningEffort && this.config.reasoningEffort !== "none") {
        const budgetMap = { low: 2048, medium: 8192, high: 32000 };
        const budget = budgetMap[this.config.reasoningEffort as "low" | "medium" | "high"] || 8192;
        env.MAX_THINKING_TOKENS = String(budget);
      }

      const continueFlag = isContinue ? "-c " : "";
      return {
        command: `claude ${continueFlag}-p "$(cat "${promptFilePath}")" ${flags.join(" ")}`,
        env,
      };
    }
  }

  private async captureFullDiff(cwd: string, startCommit?: string): Promise<string> {
    const checkGit = await this.sandbox.exec("git rev-parse --is-inside-work-tree", { cwd });
    if (checkGit.exitCode !== 0) {
      return "";
    }

    // 1. If baseBranch is specified, diff directly against it
    if (this.config.baseBranch && /^[a-zA-Z0-9._\-/]+$/.test(this.config.baseBranch)) {
      const branchDiff = await this.sandbox.exec(`git diff "${this.config.baseBranch}...HEAD"`, { cwd });
      if (branchDiff.exitCode === 0 && branchDiff.stdout.trim()) {
        return branchDiff.stdout;
      }
    }

    // 2. If we recorded a startCommit and new commits were created, diff from startCommit to HEAD
    const currentCommit = await this.getCurrentCommit(cwd);
    if (startCommit && currentCommit && startCommit !== currentCommit) {
      const commitDiff = await this.sandbox.exec(`git diff "${startCommit}..HEAD"`, { cwd });
      const workingDiff = await this.sandbox.exec("git diff HEAD", { cwd });
      return [commitDiff.stdout, workingDiff.stdout].filter(Boolean).join("\n");
    }

    // 3. Otherwise diff uncommitted changes (both staged and unstaged)
    const headDiff = await this.sandbox.exec("git diff HEAD", { cwd });
    if (headDiff.exitCode === 0 && headDiff.stdout.trim()) {
      return headDiff.stdout;
    }

    return (await this.sandbox.gitDiff()).trim();
  }

  private async captureRefreshedAuth(provider: AgentProvider): Promise<string | undefined> {
    const candidatePaths =
      provider === "codex"
        ? ["/home/user/.codex/auth.json", "/root/.codex/auth.json"]
        : ["/home/user/.claude.json", "/root/.claude.json"];

    for (const authPath of candidatePaths) {
      try {
        const content = await this.sandbox.readFile(authPath);
        if (content.trim()) {
          return content;
        }
      } catch {
        // Try next candidate path
      }
    }
    return undefined;
  }
}
