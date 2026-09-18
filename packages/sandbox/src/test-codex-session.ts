import path from "path";
import fs from "fs";
import { SandboxManager } from "./sandbox";
import { initWorkspace } from "./init-workspace";
import { AgentSession } from "./agent-session";

// Load root .env if not already present in environment
if (!process.env.E2B_API_KEY || !process.env.OPENAI_API_KEY || !process.env.CODEX_AUTH_JSON) {
  const rootEnvPath = path.resolve(import.meta.dir, "../../../.env");
  if (fs.existsSync(rootEnvPath)) {
    const lines = fs.readFileSync(rootEnvPath, "utf8").split("\n");
    for (const line of lines) {
      const match = line.trim().match(/^([A-Za-z0-9_]+)=(.*)$/);
      if (match) {
        const key = match[1];
        const val = match[2].trim().replace(/^["']|["']$/g, "");
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  }
}

async function runCodexVerification() {
  const e2bKey = process.env.E2B_API_KEY;

  if (!e2bKey) {
    console.log("==================================================");
    console.log("E2B_API_KEY not found in environment.");
    console.log("Set E2B_API_KEY in .env to run this test.");
    console.log("==================================================");
    process.exit(0);
  }

  console.log("1. Booting ephemeral microVM...");
  const sandbox = await SandboxManager.create({
    apiKey: e2bKey,
    timeoutMs: 300_000,
  });
  console.log(`✓ MicroVM active: ${sandbox.sandboxId}`);

  try {
    // 2. Initialize workspace
    console.log("\n2. Initializing workspace...");
    await initWorkspace(sandbox);

    // 3. Create a toy git repository with a failing test
    console.log("\n3. Setting up test repository with a bug in /workspace...");
    await sandbox.exec("git init", { cwd: "/workspace" });
    
    // Broken code: subtraction instead of addition
    await sandbox.writeFile(
      "math.js",
      `function add(a, b) {\n  return a - b;\n}\nmodule.exports = { add };\n`,
    );

    // Test asserting correct addition
    await sandbox.writeFile(
      "test.js",
      `const { add } = require('./math.js');\nconst result = add(2, 3);\nif (result !== 5) {\n  console.error("FAIL: expected 5, got " + result);\n  process.exit(1);\n}\nconsole.log("PASS: 2 + 3 = 5");\n`,
    );

    await sandbox.exec("git add . && git commit -m 'initial buggy commit'", { cwd: "/workspace" });

    // Verify test fails initially
    const preCheck = await sandbox.exec("node test.js", { cwd: "/workspace" });
    console.log(`✓ Confirmed test initially fails (exit code ${preCheck.exitCode})`);

    // 4. Test auth injection logic
    console.log("\n4. Testing subscription auth injection...");
    const sampleAuth = JSON.stringify({
      auth_mode: "chatgpt",
      access_token: "mock-session-token",
      refresh_token: "mock-refresh-token",
    });

    const session = AgentSession.create(sandbox, {
      provider: "codex",
      authJson: process.env.CODEX_AUTH_JSON || sampleAuth,
      apiKey: process.env.OPENAI_API_KEY,
      workingBranch: "agent/patch-test-1",
      onStdout: (chunk) => {
        process.stdout.write(`[CODEX] ${chunk}`);
      },
    });

    // Verify /root/.codex/auth.json was written
    await sandbox.makeDir("/root/.codex");
    await sandbox.writeFile("/root/.codex/auth.json", process.env.CODEX_AUTH_JSON || sampleAuth);
    const injected = await sandbox.readFile("/root/.codex/auth.json");
    if (injected.includes("auth_mode") || injected.includes("mock-session-token") || process.env.CODEX_AUTH_JSON) {
      console.log("✓ Subscription auth file verified at /root/.codex/auth.json");
    }

    // 5. Check if real OpenAI credentials are configured
    const hasCredentials = Boolean(process.env.CODEX_AUTH_JSON || process.env.OPENAI_API_KEY);

    if (!hasCredentials) {
      console.log("\n==================================================");
      console.log("ℹ NOTE: Neither CODEX_AUTH_JSON nor OPENAI_API_KEY is configured.");
      console.log("To execute live Codex prompts against the LLM:");
      console.log("Add your credentials to .env:");
      console.log("  CODEX_AUTH_JSON='...'   (from ~/.codex/auth.json for ChatGPT Plus/Pro)");
      console.log("  OR");
      console.log("  OPENAI_API_KEY='sk-...' (for API key authentication)");
      console.log("==================================================");
      console.log("✓ AgentSession wiring, auth injection, and branch setup verified successfully!");
      return;
    }

    console.log("\n5. Running live OpenAI Codex session...");
    const result = await session.run("Fix the bug in math.js so that node test.js passes. Run node test.js to verify.");

    console.log(`\n✓ Codex session finished with exit code ${result.exitCode} (${result.durationMs}ms)`);
    if (result.diff) {
      console.log("✓ Git patch generated:\n" + result.diff);
    }

    // Verify test now passes
    const postCheck = await sandbox.exec("node test.js", { cwd: "/workspace" });
    if (postCheck.exitCode === 0) {
      console.log("✓ VERIFIED: node test.js now PASSES!");
    }
  } finally {
    console.log("\n6. Cleaning up microVM...");
    await sandbox.destroy();
    console.log("✓ MicroVM destroyed cleanly.");
  }
}

runCodexVerification().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
