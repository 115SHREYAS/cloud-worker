import type { SandboxManager } from "./sandbox";
import type { WorkspaceInitResult } from "./types";

/**
 * Configures guest-level egress firewall rules inside the microVM.
 * Blocks cloud provider instance metadata (169.254.169.254) and private RFC1918 subnets
 * while allowing loopback and public outbound traffic.
 */
export async function setupEgressFirewall(sandbox: SandboxManager): Promise<boolean> {
  const firewallScript = `
set -e
if command -v iptables >/dev/null 2>&1; then
  # Allow loopback interface
  iptables -A OUTPUT -o lo -j ACCEPT
  # Allow established and related connections if conntrack is supported
  iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT || true
  # Allow outbound DNS resolution before blocking private/link-local ranges
  iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
  iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT
  # Reject cloud metadata services immediately to prevent credential exfiltration
  iptables -A OUTPUT -d 169.254.169.254/32 -j REJECT
  iptables -A OUTPUT -d 169.254.0.0/16 -j REJECT
  # Reject internal private VPC subnets
  iptables -A OUTPUT -d 10.0.0.0/8 -j REJECT
  iptables -A OUTPUT -d 172.16.0.0/12 -j REJECT
  iptables -A OUTPUT -d 192.168.0.0/16 -j REJECT
  echo "FIREWALL_APPLIED"
else
  echo "NO_IPTABLES"
  exit 1
fi
`.trim();

  try {
    const res = await sandbox.exec(firewallScript);
    return res.stdout.includes("FIREWALL_APPLIED");
  } catch (err) {
    console.warn("[init-workspace] Egress firewall configuration skipped or failed:", err);
    return false;
  }
}

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

  // 3. Configure network isolation firewall
  const firewallConfigured = await setupEgressFirewall(sandbox);

  // 4. Probe available development toolchains
  const [gitRes, nodeRes, npmRes, pythonRes] = await Promise.all([
    sandbox.exec("git --version"),
    sandbox.exec("node --version"),
    sandbox.exec("npm --version"),
    sandbox.exec("python3 --version"),
  ]);

  return {
    workspacePath: "/workspace",
    firewallConfigured,
    tools: {
      git: gitRes.exitCode === 0 ? gitRes.stdout.trim() : undefined,
      node: nodeRes.exitCode === 0 ? nodeRes.stdout.trim() : undefined,
      npm: npmRes.exitCode === 0 ? npmRes.stdout.trim() : undefined,
      python: pythonRes.exitCode === 0 ? pythonRes.stdout.trim() : undefined,
    },
  };
}
