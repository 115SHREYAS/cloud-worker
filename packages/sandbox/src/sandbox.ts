import { Sandbox, CommandExitError } from "e2b";
import type {
  CommandExecutionResult,
  FileEntry,
} from "@cloud-worker/shared";
import type {
  ExecOptions,
  ReadFileOptions,
  SandboxManagerConfig,
} from "./types";

export class SandboxManager {
  private constructor(
    public readonly sandbox: Sandbox,
    private destroyed: boolean = false,
  ) {}

  public get sandboxId(): string {
    return this.sandbox.sandboxId;
  }

  public get isDestroyed(): boolean {
    return this.destroyed;
  }

  /**
   * Provisions a new ephemeral E2B microVM.
   */
  public static async create(config: SandboxManagerConfig = {}): Promise<SandboxManager> {
    const timeoutMs = config.timeoutMs ?? 900_000; // 15 minutes default TTL
    const template = config.templateId ?? config.template;
    const envs = config.env ?? config.envs;

    const opts = {
      timeoutMs,
      envs,
      apiKey: config.apiKey,
    };

    const sandbox = template
      ? await Sandbox.create(template, opts)
      : await Sandbox.create(opts);

    return new SandboxManager(sandbox);
  }

  /**
   * Reconnects to an already running microVM by ID.
   */
  public static async connect(sandboxId: string, apiKey?: string): Promise<SandboxManager> {
    const sandbox = await Sandbox.connect(sandboxId, { apiKey });
    return new SandboxManager(sandbox);
  }

  /**
   * Extends or adjusts the microVM execution timeout.
   */
  public async setTimeout(timeoutMs: number): Promise<void> {
    this.assertActive();
    await this.sandbox.setTimeout(timeoutMs);
  }

  /**
   * Executes a bash command inside the microVM and streams real-time chunks.
   * Intercepts CommandExitError so non-zero exits return cleanly.
   */
  public async exec(
    command: string,
    options: ExecOptions = {},
  ): Promise<CommandExecutionResult> {
    this.assertActive();

    const cwd = options.cwd ?? "/workspace";
    const timeoutMs = options.timeoutMs ?? 120_000;
    const maxOutputChars = options.maxOutputChars ?? 1_000_000;
    const startTime = Date.now();

    let stdoutBuffer = "";
    let stderrBuffer = "";

    const appendWithLimit = (current: string, chunk: string): string => {
      if (current.length >= maxOutputChars) {
        return current;
      }
      const combined = current + chunk;
      if (combined.length > maxOutputChars) {
        return combined.slice(0, maxOutputChars) + "\n[Output truncated due to size limit]";
      }
      return combined;
    };

    try {
      const result = await this.sandbox.commands.run(command, {
        cwd,
        envs: options.env,
        timeoutMs,
        onStdout: async (chunk: string) => {
          stdoutBuffer = appendWithLimit(stdoutBuffer, chunk);
          if (options.onStdout) {
            await options.onStdout(chunk);
          }
        },
        onStderr: async (chunk: string) => {
          stderrBuffer = appendWithLimit(stderrBuffer, chunk);
          if (options.onStderr) {
            await options.onStderr(chunk);
          }
        },
      });

      return {
        exitCode: result.exitCode,
        stdout: stdoutBuffer || result.stdout || "",
        stderr: stderrBuffer || result.stderr || "",
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;

      if (error instanceof CommandExitError) {
        return {
          exitCode: error.exitCode,
          stdout: stdoutBuffer || error.stdout || "",
          stderr: stderrBuffer || error.stderr || "",
          durationMs,
        };
      }

      // Process was killed or timed out
      const message = error instanceof Error ? error.message : String(error);
      return {
        exitCode: null,
        stdout: stdoutBuffer,
        stderr: stderrBuffer ? `${stderrBuffer}\n${message}` : message,
        durationMs,
      };
    }
  }

  /**
   * Reads a file from the microVM filesystem with optional line slicing.
   */
  public async readFile(
    filePath: string,
    options: ReadFileOptions = {},
  ): Promise<string> {
    this.assertActive();
    const normalizedPath = this.resolvePath(filePath);

    const content = await this.sandbox.files.read(normalizedPath, {
      format: "text",
    });

    if (options.startLine === undefined && options.endLine === undefined) {
      return content;
    }

    const lines = content.split("\n");
    const start = options.startLine ? Math.max(0, options.startLine - 1) : 0;
    const end = options.endLine ? Math.min(lines.length, options.endLine) : lines.length;

    return lines.slice(start, end).join("\n");
  }

  /**
   * Writes content to a file. E2B automatically creates missing parent directories.
   */
  public async writeFile(filePath: string, content: string): Promise<void> {
    this.assertActive();
    const normalizedPath = this.resolvePath(filePath);
    await this.sandbox.files.write(normalizedPath, content);
  }

  /**
   * Creates a directory in the microVM.
   */
  public async makeDir(dirPath: string): Promise<void> {
    this.assertActive();
    const normalizedPath = this.resolvePath(dirPath);
    await this.sandbox.files.makeDir(normalizedPath);
  }

  /**
   * Lists directory contents, returning typed FileEntry items.
   */
  public async listDirectory(
    dirPath: string = "/workspace",
    recursive: boolean = false,
  ): Promise<FileEntry[]> {
    this.assertActive();
    const normalizedPath = this.resolvePath(dirPath);

    if (recursive) {
      // Use python in the microVM to reliably traverse the filesystem with accurate file/dir types
      const script = `
import os, json
results = []
try:
    for root, dirs, files in os.walk('.', followlinks=False):
        depth = root.count(os.sep)
        if depth >= 5:
            dirs.clear()
            continue
        for d in dirs:
            rel = os.path.normpath(os.path.join(root, d)).replace('\\\\', '/')
            results.append({'name': d, 'path': rel, 'isDirectory': True})
        for f in files:
            rel = os.path.normpath(os.path.join(root, f)).replace('\\\\', '/')
            size = os.path.getsize(rel) if os.path.exists(rel) else 0
            results.append({'name': f, 'path': rel, 'isDirectory': False, 'size': size})
    print(json.dumps(results))
except Exception as e:
    print(json.dumps([]))
`.trim();

      const execResult = await this.exec(`python3 -c "${script.replace(/"/g, '\\"')}"`, {
        cwd: normalizedPath,
      });

      if (execResult.exitCode === 0 && execResult.stdout.trim()) {
        try {
          const rawEntries = JSON.parse(execResult.stdout.trim()) as Array<{
            name: string;
            path: string;
            isDirectory: boolean;
            size?: number;
          }>;

          return rawEntries.map((e) => ({
            name: e.name,
            path: `${normalizedPath}/${e.path}`.replace(/\/+/g, "/"),
            isDirectory: e.isDirectory,
            size: e.size,
          }));
        } catch {
          // Fallback to shallow listing if parsing fails
        }
      }
    }

    const entries = await this.sandbox.files.list(normalizedPath);

    return entries.map((entry) => ({
      name: entry.name,
      path: entry.path,
      isDirectory: entry.type === "dir",
      size: entry.size,
    }));
  }

  /**
   * Captures git diff inside the workspace.
   */
  public async gitDiff(staged: boolean = false): Promise<string> {
    this.assertActive();
    const cmd = staged ? "git diff --cached" : "git diff";
    const result = await this.exec(cmd, { cwd: "/workspace" });
    return result.stdout;
  }

  /**
   * Terminates the microVM instance.
   */
  public async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;

    try {
      await this.sandbox.kill();
    } catch {
      // Ignore errors if sandbox was already stopped
    }
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    await this.destroy();
  }

  private resolvePath(targetPath: string): string {
    if (targetPath.startsWith("/")) {
      return targetPath;
    }
    return `/workspace/${targetPath}`.replace(/\/+/g, "/");
  }

  private assertActive(): void {
    if (this.destroyed) {
      throw new Error(`Sandbox ${this.sandbox.sandboxId} has been destroyed`);
    }
  }
}
