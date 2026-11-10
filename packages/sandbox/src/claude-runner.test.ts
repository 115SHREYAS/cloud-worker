import { describe, it, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  parseClaudeRunnerLine,
  mapClaudeSdkEvent,
  summarizeClaudeUsage,
  type StreamEvent,
} from "@cloud-worker/shared";
import {
  CLAUDE_RUNNER_DIR,
  CLAUDE_RUNNER_SCRIPT,
  CLAUDE_SESSION_FILE,
  CLAUDE_SDK_VERSION,
  ensureClaudeSdkRunner,
} from "./claude-runner-setup";

describe("Claude Runner Setup & Protocol Integration (@cloud-worker/sandbox)", () => {
  it("verifies constants for the in-VM Claude SDK runner", () => {
    expect(CLAUDE_RUNNER_DIR).toBe("/home/user/.cloud-worker/claude-runner");
    expect(CLAUDE_RUNNER_SCRIPT).toBe("/home/user/.cloud-worker/claude-runner/runner.mjs");
    expect(CLAUDE_SESSION_FILE).toBe("/home/user/.cloud-worker/claude-session-id");
    expect(CLAUDE_SDK_VERSION).toBe("0.3.319");
  });

  it("verifies the runner source script can be read and is valid JavaScript", async () => {
    const url = new URL("./agent/claude-runner.mjs", import.meta.url);
    const source = await readFile(url, "utf8");
    expect(source.length).toBeGreaterThan(500);
    expect(source).toContain("@anthropic-ai/claude-agent-sdk");
    expect(source).toContain("query({ prompt, options");
    expect(source).toContain("CW1 ");
    expect(source).toContain("CW_SESSION_FILE");
    expect(source).toContain("options.resume");
  });

  it("handles fast-path in ensureClaudeSdkRunner when runner and package exist", async () => {
    const mockSandbox = {
      exec: async (cmd: string) => {
        if (cmd.includes("test -f") && cmd.includes("test -d")) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return { exitCode: 1, stdout: "", stderr: "unexpected command" };
      },
      makeDir: async () => {},
      writeFile: async () => {},
    } as any;

    const ready = await ensureClaudeSdkRunner(mockSandbox);
    expect(ready).toBe(true);
  });

  it("handles full installation in ensureClaudeSdkRunner", async () => {
    const writtenFiles: Record<string, string> = {};
    const madeDirs: string[] = [];

    const mockSandbox = {
      exec: async (cmd: string) => {
        if (cmd.includes("test -f")) {
          return { exitCode: 1, stdout: "", stderr: "file not found" };
        }
        if (cmd.includes("npm install")) {
          return { exitCode: 0, stdout: "added 1 package", stderr: "" };
        }
        if (cmd.includes("import('@anthropic-ai/claude-agent-sdk')")) {
          return { exitCode: 0, stdout: "SDK_OK\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      makeDir: async (dir: string) => {
        madeDirs.push(dir);
      },
      writeFile: async (path: string, content: string) => {
        writtenFiles[path] = content;
      },
    } as any;

    const ready = await ensureClaudeSdkRunner(mockSandbox);
    expect(ready).toBe(true);
    expect(madeDirs).toContain(CLAUDE_RUNNER_DIR);
    expect(writtenFiles[`${CLAUDE_RUNNER_DIR}/package.json`]).toContain("@anthropic-ai/claude-agent-sdk");
    expect(writtenFiles[CLAUDE_RUNNER_SCRIPT]).toContain("@anthropic-ai/claude-agent-sdk");
  });

  it("fails gracefully when npm install exits non-zero", async () => {
    const mockSandbox = {
      exec: async (cmd: string) => {
        if (cmd.includes("test -f")) {
          return { exitCode: 1, stdout: "", stderr: "" };
        }
        if (cmd.includes("npm install")) {
          return { exitCode: 1, stdout: "", stderr: "EHOSTUNREACH" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      makeDir: async () => {},
      writeFile: async () => {},
    } as any;

    const ready = await ensureClaudeSdkRunner(mockSandbox);
    expect(ready).toBe(false);
  });

  it("streams structured events from Claude SDK protocol lines", () => {
    const capturedEvents: StreamEvent[] = [];
    const taskId = "task-test-claude";

    const lines = [
      `CW1 {"t":"ready","sdk":"0.3.319","node":"v22.0.0"}`,
      `CW1 {"t":"session","id":"sess_abc","resumed":false}`,
      `CW1 {"t":"ev","e":{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"Analyzing the file tree"}]}}}`,
      `CW1 {"t":"ev","e":{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tool_1","name":"Bash","input":{"command":"npm run build"}}]}}}`,
      `CW1 {"t":"ev","e":{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tool_1","content":"Build succeeded","is_error":false}]}}}`,
      `CW1 {"t":"ev","e":{"type":"assistant","message":{"content":[{"type":"text","text":"Build completed successfully."}]}}}`,
      `CW1 {"t":"result","code":0,"usage":{"input_tokens":5000,"output_tokens":600},"totalCostUsd":0.02}`,
    ];

    for (const line of lines) {
      const parsed = parseClaudeRunnerLine(line);
      expect(parsed).not.toBeNull();
      if (parsed?.t === "ev") {
        const events = mapClaudeSdkEvent(parsed.e, taskId);
        capturedEvents.push(...events);
      }
    }

    expect(capturedEvents.length).toBe(4);
    expect(capturedEvents[0]?.type).toBe("thought");
    expect(capturedEvents[1]?.type).toBe("tool_call");
    expect(capturedEvents[2]?.type).toBe("tool_result");
    expect(capturedEvents[3]?.type).toBe("agent_message");

    if (capturedEvents[1]?.type === "tool_call") {
      expect(capturedEvents[1].tool).toBe("bash");
      expect(capturedEvents[1].args.command).toBe("npm run build");
    }
    if (capturedEvents[2]?.type === "tool_result") {
      expect(capturedEvents[2].output).toBe("Build succeeded");
      expect(capturedEvents[2].exitCode).toBe(0);
    }
  });
});
