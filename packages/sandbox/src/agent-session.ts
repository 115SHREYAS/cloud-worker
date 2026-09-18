import type { SandboxManager } from "./sandbox";
import type { AgentSessionConfig, AgentSessionResult, AgentProvider } from "./types";

export class AgentSession {
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
   * Prepares credentials, ensures the CLI binary is available, and executes the agent prompt inside /workspace.
   */
  public async run(prompt: string): Promise<AgentSessionResult> {
    const provider: AgentProvider = this.config.provider ?? "codex";
    const cwd = this.config.cwd ?? "/workspace";
    const timeoutMs = this.config.timeoutMs ?? 600_000; // 10 minutes default
    const startTime = Date.now();

    // 1. Inject subscription authentication or API key
    await this.injectAuth(provider);

    // 2. Ensure CLI binary exists in microVM
    await this.ensureCli(provider);

    // 3. Record baseline git commit & set up working branch if specified
    const startCommit = await this.getCurrentCommit(cwd);
    if (this.config.workingBranch) {
      await this.setupWorkingBranch(this.config.workingBranch, cwd);
    }

    // 4. Safely store prompt in /tmp to avoid polluting /workspace git status
    const promptId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const promptFilePath = `/tmp/.agent-prompt-${promptId}.txt`;
    await this.sandbox.writeFile(promptFilePath, prompt);

    let execResult: { exitCode: number | null; stdout: string; stderr: string };
    let refreshedAuthJson: string | undefined;

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
      // 5. Build execution command and environment
      const { command, env } = this.buildRunCommand(provider, promptFilePath);

      // 6. Execute CLI with live stdout/stderr streaming
      const res = await this.sandbox.exec(command, {
        cwd,
        env,
        timeoutMs,
        onStdout: this.config.onStdout,
        onStderr: this.config.onStderr,
      });

      execResult = {
        exitCode: res.exitCode,
        stdout: res.stdout,
        stderr: res.stderr,
      };
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

    return {
      exitCode: execResult.exitCode,
      stdout: execResult.stdout,
      stderr: execResult.stderr,
      diff,
      durationMs: Date.now() - startTime,
      refreshedAuthJson,
    };
  }

  private async injectAuth(provider: AgentProvider): Promise<void> {
    if (provider === "codex") {
      if (this.config.authJson) {
        await this.sandbox.makeDir("/root/.codex");
        await this.sandbox.writeFile("/root/.codex/auth.json", this.config.authJson);
        await this.sandbox.exec("chmod 600 /root/.codex/auth.json");
      }
    } else if (provider === "claude") {
      if (this.config.authJson) {
        await this.sandbox.writeFile("/root/.claude.json", this.config.authJson);
        await this.sandbox.exec("chmod 600 /root/.claude.json");
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
      await this.sandbox.exec(`git checkout -B "${branch}"`, { cwd });
    }
  }

  private buildRunCommand(
    provider: AgentProvider,
    promptFilePath: string,
  ): { command: string; env: Record<string, string> } {
    const env: Record<string, string> = {
      CI: "1",
      NON_INTERACTIVE: "1",
    };

    if (this.config.apiKey) {
      if (provider === "codex") {
        env.OPENAI_API_KEY = this.config.apiKey;
      } else {
        env.ANTHROPIC_API_KEY = this.config.apiKey;
      }
    }

    if (this.config.githubToken) {
      env.GITHUB_TOKEN = this.config.githubToken;
      env.GH_TOKEN = this.config.githubToken;
    }

    if (provider === "codex") {
      // Non-interactive codex execution with full-auto approval
      return {
        command: `codex exec --full-auto "$(cat "${promptFilePath}")"`,
        env,
      };
    } else {
      // Headless claude code execution skipping interactive permission prompts
      return {
        command: `claude -p "$(cat "${promptFilePath}")" --dangerously-skip-permissions`,
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
    const authPath = provider === "codex" ? "/root/.codex/auth.json" : "/root/.claude.json";
    try {
      const content = await this.sandbox.readFile(authPath);
      return content.trim() ? content : undefined;
    } catch {
      return undefined;
    }
  }
}
