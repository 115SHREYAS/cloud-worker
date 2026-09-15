import type { SandboxManager } from "./sandbox";
import type { WorkspaceInitResult } from "./types";

export async function initWorkspace(
  sandbox: SandboxManager,
): Promise<WorkspaceInitResult> {
  // 1. Ensure /workspace exists
  await sandbox.makeDir("/workspace");

  // 2. Configure Git globals for the agent inside the VM
  await sandbox.exec('git config --global user.name "Cloud Worker Agent"');
  await sandbox.exec('git config --global user.email "agent@cloudworker.local"');
  await sandbox.exec("git config --global --add safe.directory /workspace");
  await sandbox.exec("git config --global init.defaultBranch main");

  // 3. Probe available development toolchains
  const [gitRes, nodeRes, npmRes, pythonRes] = await Promise.all([
    sandbox.exec("git --version"),
    sandbox.exec("node --version"),
    sandbox.exec("npm --version"),
    sandbox.exec("python3 --version"),
  ]);

  return {
    workspacePath: "/workspace",
    tools: {
      git: gitRes.exitCode === 0 ? gitRes.stdout.trim() : undefined,
      node: nodeRes.exitCode === 0 ? nodeRes.stdout.trim() : undefined,
      npm: npmRes.exitCode === 0 ? npmRes.stdout.trim() : undefined,
      python: pythonRes.exitCode === 0 ? pythonRes.stdout.trim() : undefined,
    },
  };
}
