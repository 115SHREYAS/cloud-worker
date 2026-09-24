import { existsSync, readFileSync, promises as fs } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import type { TaskRepository } from "../db/repository.ts";
import type { AgentProvider } from "@cloud-worker/sandbox";

export interface DetectedProviderAuth {
  provider: AgentProvider;
  available: boolean;
  source: string;
  planName?: string;
  hasToken: boolean;
  email?: string;
}

export interface ProviderAuthFlow {
  id: string;
  provider: AgentProvider;
  userId: string;
  phase: "starting" | "waiting_for_user" | "verifying" | "succeeded" | "failed" | "cancelled";
  authorizationUrl?: string;
  userCode?: string;
  message?: string;
  error?: string;
  createdAt: number;
  expiresAt: number;
}

interface ActiveFlowEntry {
  flow: ProviderAuthFlow;
  process?: ChildProcess;
  tempDir?: string;
}

class ProviderAuthRelay {
  private activeFlows = new Map<string, ActiveFlowEntry>();

  /**
   * Detects whether the host system already has authenticated Codex or Claude credentials.
   */
  public async detectLocalCredentials(): Promise<DetectedProviderAuth[]> {
    const results: DetectedProviderAuth[] = [];

    // 1. Detect Codex
    const codexPath = join(homedir(), ".codex", "auth.json");
    if (existsSync(codexPath)) {
      try {
        const raw = readFileSync(codexPath, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed && (parsed.auth_mode === "chatgpt" || parsed.tokens || parsed.OPENAI_API_KEY)) {
          let email: string | undefined;
          if (parsed.tokens?.id_token) {
            try {
              const payloadPart = parsed.tokens.id_token.split(".")[1];
              if (payloadPart) {
                const payload = JSON.parse(Buffer.from(payloadPart, "base64").toString("utf8"));
                email = payload.email;
              }
            } catch {
              // Ignore JWT decode error
            }
          }

          results.push({
            provider: "codex",
            available: true,
            source: "~/.codex/auth.json",
            planName: "ChatGPT Plus/Pro",
            hasToken: true,
            email,
          });
        }
      } catch {
        // Ignore JSON parse error
      }
    }

    // 2. Detect Claude
    const claudePath = join(homedir(), ".claude.json");
    const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
    const claudeConfigPath = join(claudeConfigDir, "config.json");

    let claudeFound = false;
    let claudeEmail: string | undefined;

    if (existsSync(claudePath)) {
      try {
        const raw = readFileSync(claudePath, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed) {
          if (parsed.oauthAccount?.emailAddress) {
            claudeEmail = parsed.oauthAccount.emailAddress;
          }
          claudeFound = true;
        }
      } catch {
        // Ignore
      }
    } else if (existsSync(claudeConfigPath)) {
      claudeFound = true;
    } else if (process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY) {
      claudeFound = true;
    }

    if (claudeFound) {
      results.push({
        provider: "claude",
        available: true,
        source: existsSync(claudePath) ? "~/.claude.json" : "Environment / Claude Config",
        planName: "Claude Subscription",
        hasToken: true,
        email: claudeEmail,
      });
    }

    return results;
  }

  /**
   * Imports existing credentials from the host machine into the user's account.
   */
  public async importLocalCredentials(
    repo: TaskRepository,
    provider: AgentProvider,
    userId: string,
  ): Promise<{ ok: boolean; provider: AgentProvider }> {
    if (provider === "codex") {
      const codexPath = join(homedir(), ".codex", "auth.json");
      if (!existsSync(codexPath)) {
        throw new Error("No local Codex credentials found in ~/.codex/auth.json");
      }
      const raw = readFileSync(codexPath, "utf8");
      await repo.saveAuthSession("codex", raw, userId, "subscription");
      try {
        await repo.updateUser(userId, { defaultModel: "codex", defaultAuthMode: "subscription" });
      } catch {
        // Ignore if user record is not yet created
      }
      return { ok: true, provider: "codex" };
    }

    if (provider === "claude") {
      const claudePath = join(homedir(), ".claude.json");
      if (existsSync(claudePath)) {
        const raw = readFileSync(claudePath, "utf8");
        await repo.saveAuthSession("claude", raw, userId, "subscription");
        try {
          await repo.updateUser(userId, { defaultModel: "claude", defaultAuthMode: "subscription" });
        } catch {
          // Ignore
        }
        return { ok: true, provider: "claude" };
      }

      if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
        const token = process.env.CLAUDE_CODE_OAUTH_TOKEN.trim();
        await repo.saveAuthSession("claude", token, userId, "subscription");
        try {
          await repo.updateUser(userId, { defaultModel: "claude", defaultAuthMode: "subscription" });
        } catch {
          // Ignore
        }
        return { ok: true, provider: "claude" };
      }

      throw new Error("No local Claude credentials found in ~/.claude.json or environment");
    }

    throw new Error(`Unsupported provider: ${provider}`);
  }

  /**
   * Starts an interactive CLI device/browser OAuth login flow.
   */
  public async startLoginFlow(
    repo: TaskRepository,
    provider: AgentProvider,
    userId: string,
  ): Promise<ProviderAuthFlow> {
    const flowId = `flow_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    const expiresAt = now + 15 * 60 * 1000; // 15 minutes

    const flow: ProviderAuthFlow = {
      id: flowId,
      provider,
      userId,
      phase: "starting",
      message: "Initializing authentication...",
      createdAt: now,
      expiresAt,
    };

    const entry: ActiveFlowEntry = { flow };
    this.activeFlows.set(flowId, entry);

    if (provider === "codex") {
      this.runCodexDeviceAuth(repo, entry).catch((err) => {
        console.error(`[auth-relay] Codex flow ${flowId} error:`, err);
        flow.phase = "failed";
        flow.error = err instanceof Error ? err.message : String(err);
      });
    } else if (provider === "claude") {
      this.runClaudeAuth(repo, entry).catch((err) => {
        console.error(`[auth-relay] Claude flow ${flowId} error:`, err);
        flow.phase = "failed";
        flow.error = err instanceof Error ? err.message : String(err);
      });
    }

    return flow;
  }

  /**
   * Runs the OpenAI Codex device login flow (`codex login --device-auth`).
   */
  private async runCodexDeviceAuth(repo: TaskRepository, entry: ActiveFlowEntry): Promise<void> {
    const { flow } = entry;
    const tempDir = join(tmpdir(), `codex_auth_${flow.id}`);
    await fs.mkdir(tempDir, { recursive: true });
    entry.tempDir = tempDir;

    const isWindows = process.platform === "win32";
    const command = isWindows ? "codex.cmd" : "codex";

    const proc = spawn(command, ["login", "--device-auth"], {
      env: {
        ...process.env,
        CODEX_HOME: tempDir,
      },
      shell: isWindows,
    });

    entry.process = proc;

    let stdoutBuffer = "";
    const stripAnsi = (str: string) =>
      str.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");

    const handleChunk = (chunk: Buffer) => {
      const rawText = chunk.toString("utf8");
      stdoutBuffer += stripAnsi(rawText);

      // Extract device login URL: https://auth.openai.com/codex/device
      const urlMatch =
        stdoutBuffer.match(/(https:\/\/auth\.openai\.com\/codex\/device[^\s]*)/i) ||
        stdoutBuffer.match(/(https:\/\/auth\.openai\.com[^\s]*)/i);

      // Extract user code: strictly UPPERCASE letters and digits with a dash (e.g. V02H-NNAJ7)
      const codeMatch =
        stdoutBuffer.match(/code[^\n]*\n\s*([A-Z0-9]{4,6}-[A-Z0-9]{4,6})/i) ||
        stdoutBuffer.match(/\b([A-Z0-9]{4,6}-[A-Z0-9]{4,6})\b/);

      const matchedUrl = urlMatch?.[1];
      const matchedCode = codeMatch?.[1];

      if (matchedUrl && matchedCode && flow.phase === "starting") {
        flow.phase = "waiting_for_user";
        flow.authorizationUrl = matchedUrl.replace(/[.,;:)]+$/, "");
        flow.userCode = matchedCode;
        flow.message = `Open ${flow.authorizationUrl} and enter code: ${flow.userCode}`;
      }
    };

    proc.stdout?.on("data", handleChunk);
    proc.stderr?.on("data", handleChunk);

    return new Promise((resolve) => {
      proc.on("close", async (exitCode) => {
        try {
          if (exitCode === 0) {
            const authPath = join(tempDir, "auth.json");
            if (existsSync(authPath)) {
              const authJson = await fs.readFile(authPath, "utf8");
              await repo.saveAuthSession("codex", authJson, flow.userId, "subscription");
              try {
                await repo.updateUser(flow.userId, { defaultModel: "codex", defaultAuthMode: "subscription" });
              } catch {
                // Ignore
              }

              flow.phase = "succeeded";
              flow.message = "Successfully authenticated with ChatGPT subscription!";
            } else {
              flow.phase = "failed";
              flow.error = "Login succeeded but credentials file was not created.";
            }
          } else if (flow.phase !== "cancelled") {
            flow.phase = "failed";
            flow.error = `Codex login exited with code ${exitCode}`;
          }
        } catch (err) {
          flow.phase = "failed";
          flow.error = err instanceof Error ? err.message : String(err);
        } finally {
          // Cleanup temp directory
          try {
            await fs.rm(tempDir, { recursive: true, force: true });
          } catch {
            // Ignore cleanup failure
          }
          resolve();
        }
      });

      proc.on("error", (err) => {
        flow.phase = "failed";
        flow.error = `Failed to spawn codex process: ${err.message}`;
        resolve();
      });
    });
  }

  /**
   * Runs the Claude CLI login flow.
   */
  private async runClaudeAuth(repo: TaskRepository, entry: ActiveFlowEntry): Promise<void> {
    const { flow } = entry;
    const isWindows = process.platform === "win32";
    const command = isWindows ? "claude.exe" : "claude";

    // First check if claude is already authenticated on the host
    const detected = await this.detectLocalCredentials();
    const claudeDetected = detected.find((d) => d.provider === "claude");

    if (claudeDetected) {
      await this.importLocalCredentials(repo, "claude", flow.userId);
      flow.phase = "succeeded";
      flow.message = "Connected successfully using local Claude credentials.";
      return;
    }

    flow.phase = "waiting_for_user";
    flow.message = "Starting Claude login. Complete sign-in in your browser.";

    const proc = spawn(command, ["auth", "login", "--claudeai"], {
      shell: isWindows,
    });

    entry.process = proc;

    return new Promise((resolve) => {
      proc.on("close", async (exitCode) => {
        try {
          if (exitCode === 0) {
            await this.importLocalCredentials(repo, "claude", flow.userId);
            flow.phase = "succeeded";
            flow.message = "Successfully authenticated with Claude Code!";
          } else if (flow.phase !== "cancelled") {
            flow.phase = "failed";
            flow.error = `Claude login exited with code ${exitCode}`;
          }
        } catch (err) {
          flow.phase = "failed";
          flow.error = err instanceof Error ? err.message : String(err);
        } finally {
          resolve();
        }
      });

      proc.on("error", (err) => {
        flow.phase = "failed";
        flow.error = `Failed to spawn claude process: ${err.message}`;
        resolve();
      });
    });
  }

  /**
   * Returns current flow state by ID.
   */
  public getFlowStatus(flowId: string): ProviderAuthFlow | null {
    const entry = this.activeFlows.get(flowId);
    if (!entry) return null;

    // Check expiration
    if (Date.now() > entry.flow.expiresAt && entry.flow.phase === "waiting_for_user") {
      entry.flow.phase = "failed";
      entry.flow.error = "Sign-in timed out. Please try again.";
      if (entry.process && !entry.process.killed) {
        entry.process.kill();
      }
    }

    return entry.flow;
  }

  /**
   * Cancels an active flow.
   */
  public cancelFlow(flowId: string): boolean {
    const entry = this.activeFlows.get(flowId);
    if (!entry) return false;

    entry.flow.phase = "cancelled";
    entry.flow.message = "Sign-in was cancelled.";

    if (entry.process && !entry.process.killed) {
      entry.process.kill();
    }

    if (entry.tempDir) {
      fs.rm(entry.tempDir, { recursive: true, force: true }).catch(() => {});
    }

    return true;
  }
}

export const providerAuthRelay = new ProviderAuthRelay();
