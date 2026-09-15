import path from "path";
import fs from "fs";
import { SandboxManager } from "./sandbox";
import { initWorkspace } from "./init-workspace";

// Load root .env if not already present in environment
if (!process.env.E2B_API_KEY) {
  const rootEnvPath = path.resolve(import.meta.dir, "../../../.env");
  if (fs.existsSync(rootEnvPath)) {
    const lines = fs.readFileSync(rootEnvPath, "utf8").split("\n");
    for (const line of lines) {
      const match = line.trim().match(/^([A-Za-z0-9_]+)=(.*)$/);
      if (match && match[1] === "E2B_API_KEY") {
        process.env.E2B_API_KEY = match[2].trim().replace(/^["']|["']$/g, "");
      }
    }
  }
}

async function runVerification() {
  const apiKey = process.env.E2B_API_KEY;

  if (!apiKey) {
    console.log("==================================================");
    console.log("E2B_API_KEY not found in environment.");
    console.log("To run this live microVM test:");
    console.log("1. Get a free API key at https://e2b.dev");
    console.log("2. Create a .env file in the root directory:");
    console.log("   E2B_API_KEY=e2b_...");
    console.log("3. Run: pnpm --filter @cloud-worker/sandbox test:sandbox");
    console.log("==================================================");
    process.exit(0);
  }

  console.log("1. Booting ephemeral E2B microVM...");
  const sandbox = await SandboxManager.create({
    apiKey,
    timeoutMs: 300_000, // 5 minutes
  });

  console.log(`✓ MicroVM active: ${sandbox.sandboxId}`);

  try {
    // 2. Initialize workspace
    console.log("\n2. Initializing workspace environment...");
    const init = await initWorkspace(sandbox);
    console.log(`✓ Workspace ready at ${init.workspacePath}`);
    console.log("Detected toolchains in microVM:", init.tools);

    // 3. Write files
    console.log("\n3. Testing file write...");
    const testScript = `
console.log("Hello from inside the E2B microVM!");
console.log("Calculated 1 + 1 =", 1 + 1);
`;
    await sandbox.writeFile("script.js", testScript.trim());
    await sandbox.writeFile("nested/subfolder/test.txt", "Nested content");
    console.log("✓ Files written to /workspace and /workspace/nested/subfolder");

    // 4. Execute command with streaming
    console.log("\n4. Executing bash command with live streaming...");
    const execResult = await sandbox.exec("node script.js", {
      onStdout: (chunk) => {
        process.stdout.write(`[VM STDOUT] ${chunk}`);
      },
    });
    console.log(`✓ Command exited with code ${execResult.exitCode} (${execResult.durationMs}ms)`);

    // 5. Test non-zero exit code interception (CommandExitError handling)
    console.log("\n5. Testing non-zero exit code interception...");
    const failedCmd = await sandbox.exec('node -e "console.error(\'Intentional error\'); process.exit(42);"');
    if (failedCmd.exitCode === 42 && failedCmd.stderr.includes("Intentional error")) {
      console.log(`✓ Successfully intercepted exit code ${failedCmd.exitCode} without crashing`);
    } else {
      throw new Error(`Unexpected non-zero exit response: ${JSON.stringify(failedCmd)}`);
    }

    // 6. Test directory listing (shallow and recursive)
    console.log("\n6. Testing directory listing...");
    const shallowList = await sandbox.listDirectory("/workspace", false);
    console.log(`✓ Shallow listing found ${shallowList.length} items`);

    const recursiveList = await sandbox.listDirectory("/workspace", true);
    console.log(`✓ Recursive listing found ${recursiveList.length} items:`, recursiveList.map((e) => e.path));

    // 7. Test line slicing in file read
    console.log("\n7. Testing file read with line slicing...");
    const line2 = await sandbox.readFile("script.js", { startLine: 2, endLine: 2 });
    console.log(`✓ Line 2 content: "${line2}"`);

    // 8. Test Git integration and diff
    console.log("\n8. Testing Git repo initialization and diff...");
    await sandbox.exec("git init", { cwd: "/workspace" });
    await sandbox.exec("git add script.js && git commit -m 'initial commit'", {
      cwd: "/workspace",
    });

    // Make a modification
    await sandbox.writeFile("script.js", testScript.trim() + '\nconsole.log("Modified by agent!");');
    const diff = await sandbox.gitDiff();
    console.log("✓ Git diff captured:\n" + diff);

    // 9. Test timeout adjustment
    console.log("\n9. Testing timeout adjustment...");
    await sandbox.setTimeout(600_000);
    console.log("✓ Sandbox timeout extended to 10 minutes");

    console.log("\n==================================================");
    console.log("✓ ALL 9 SANDBOX VERIFICATION CHECKS PASSED!");
    console.log("==================================================");
  } finally {
    // 10. Cleanup
    console.log("\n10. Destroying microVM...");
    await sandbox.destroy();
    console.log("✓ MicroVM destroyed cleanly.");
  }
}

runVerification().catch((err) => {
  console.error("Sandbox verification failed:", err);
  process.exit(1);
});
