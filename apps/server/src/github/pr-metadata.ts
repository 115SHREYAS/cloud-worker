/**
 * Semantic PR Title and Commit Message Generator
 *
 * Implements a hybrid approach:
 * 1. Checks if the agent generated an explicit title in /tmp/.pr_title or /tmp/.pr_title.txt
 * 2. Checks if the agent created clean, non-generic commits on the branch
 * 3. Inspects git diff paths to extract the component scope (e.g. auth, db, ui, queue)
 * 4. Cleans conversational noise from user prompts and generates standard Conventional Commits
 */

export interface SandboxExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface SandboxRunner {
  exec(command: string, options?: { cwd?: string; timeoutMs?: number }): Promise<SandboxExecResult>;
}

export interface PullRequestMetadata {
  title: string;
  commitMessage: string;
  changedFiles: string[];
  diffStat?: string;
}

const GENERIC_COMMIT_PATTERNS = [
  /^feat\(agent\):/i,
  /^agent commit/i,
  /^wip/i,
  /^checkpoint/i,
  /^update$/i,
  /^updates$/i,
  /^temp/i,
  /^fix$/i,
  /^initial commit/i,
  /^changes$/i,
];

export function isGenericCommitMessage(msg: string): boolean {
  const trimmed = msg.trim();
  if (trimmed.length < 6) return true;
  return GENERIC_COMMIT_PATTERNS.some((pattern) => pattern.test(trimmed));
}

const INTENT_PATTERNS: Array<{ type: string; regex: RegExp }> = [
  { type: "fix", regex: /\b(fix|fixes|fixing|fixed|bug|bugs|issue|issues|crash|crashes|broken|error|errors|failing|resolve|resolves|prevent|preventing|patch)\b/i },
  { type: "feat", regex: /\b(add|adds|adding|added|create|creates|creating|implement|implements|implementing|support|supports|new)\b/i },
  { type: "refactor", regex: /\b(refactor|refactoring|cleanup|clean up|restructure|reorganize|simplify|modernize)\b/i },
  { type: "perf", regex: /\b(perf|performance|optimize|optimization|speed up|cache|latency)\b/i },
  { type: "test", regex: /\b(test|tests|testing|unit test|integration test|spec|specs|coverage)\b/i },
  { type: "docs", regex: /\b(doc|docs|documentation|readme|comment|comments|guide)\b/i },
  { type: "chore", regex: /\b(chore|deps|dependency|dependencies|upgrade|bump|config|build|docker|compose|ci|pipeline)\b/i },
];

export function detectCommitType(prompt: string, changedFiles: string[] = []): string {
  // 1. File-based detection if all changes fall into a specific category
  if (changedFiles.length > 0) {
    const isAllTests = changedFiles.every((f) =>
      /\.(test|spec)\.[jt]sx?$|__tests__|test\//i.test(f),
    );
    if (isAllTests) return "test";

    const isAllDocs = changedFiles.every((f) =>
      /\.md$|^docs\/|LICENSE|CHANGELOG/i.test(f),
    );
    if (isAllDocs) return "docs";

    const isAllConfig = changedFiles.every((f) =>
      /package\.json|pnpm-lock|tsconfig|docker-compose|\.env|\.gitignore|turbo\.json/i.test(f),
    );
    if (isAllConfig) return "chore";
  }

  // 2. Identify primary action verb by earliest appearance in prompt
  let earliestType = "feat";
  let earliestIndex = Infinity;

  for (const item of INTENT_PATTERNS) {
    const match = item.regex.exec(prompt);
    if (match && match.index < earliestIndex) {
      earliestIndex = match.index;
      earliestType = item.type;
    }
  }

  return earliestType;
}

export function detectScope(changedFiles: string[] = []): string | undefined {
  if (changedFiles.length === 0) return undefined;

  const counts = new Map<string, number>();

  for (const file of changedFiles) {
    const lower = file.toLowerCase();
    let scope: string | null = null;

    if (lower.includes("/auth/") || lower.includes("auth")) {
      scope = "auth";
    } else if (lower.includes("/db/") || lower.includes("drizzle") || lower.includes("prisma") || lower.includes("schema")) {
      scope = "db";
    } else if (lower.includes("/queue/") || lower.includes("worker") || lower.includes("bull")) {
      scope = "queue";
    } else if (lower.includes("/events/") || lower.includes("event-bus")) {
      scope = "events";
    } else if (lower.includes("/github/") || lower.includes("webhook")) {
      scope = "github";
    } else if (lower.includes("/components/") || lower.includes("views") || lower.includes("pages") || lower.includes("ui") || lower.endsWith(".css")) {
      scope = "ui";
    } else if (lower.includes("/api/") || lower.includes("router") || lower.includes("route")) {
      scope = "api";
    } else if (lower.includes("docker") || lower.includes("compose")) {
      scope = "docker";
    } else if (lower.includes("sandbox") || lower.includes("microvm") || lower.includes("e2b")) {
      scope = "sandbox";
    } else if (lower.endsWith(".md") || lower.startsWith("docs/")) {
      scope = "docs";
    } else {
      const match = file.match(/(?:apps\/[^\/]+\/src|packages\/[^\/]+\/src|src)\/([^\/]+)/);
      if (match && match[1]) {
        scope = match[1];
      }
    }

    if (scope) {
      counts.set(scope, (counts.get(scope) || 0) + 1);
    }
  }

  if (counts.size === 0) return undefined;

  let topScope = "";
  let maxCount = 0;
  for (const [scope, count] of counts) {
    if (count > maxCount) {
      maxCount = count;
      topScope = scope;
    }
  }

  return topScope || undefined;
}

const TRAILING_DANGLING_WORDS_REGEX = /\s+(and|or|with|for|to|in|on|at|the|a|an|of|by|from|via)$/i;

export function cleanPromptSubject(prompt: string, type: string): string {
  // Take first meaningful sentence or line
  let text = prompt.replace(/\r?\n/g, " ").trim();

  // Strip code snippets and backticks
  text = text.replace(/`[^`]+`/g, "");
  text = text.replace(/"[^"]+"/g, "");

  // Remove common conversational prefixes
  text = text.replace(/^(hey|hi|hello)\s*[,!.]?\s*/i, "");
  text = text.replace(
    /^(can\s+you\s+(please\s+)?|could\s+you\s+(please\s+)?|please\s+|i\s+need\s+you\s+to\s+|i\s+want\s+you\s+to\s+|help\s+me\s+|let's\s+|we\s+need\s+to\s+|i\s+would\s+like\s+to\s+|kindly\s+)+/i,
    "",
  );

  // Remove leading redundant verbs matching the type
  if (type === "fix") {
    text = text.replace(/^(fix(es|ed|ing)?\s+(the\s+)?(issue|bug|error|problem)?\s*(where|when|with|in)?\s*)/i, "");
    text = text.replace(/^(resolve(s|d|ing)?\s+(the\s+)?)/i, "");
    text = text.replace(/^(patch(es|ed|ing)?\s+(the\s+)?)/i, "");
  } else if (type === "feat") {
    text = text.replace(/^(add(s|ed|ing)?\s+(a\s+|an\s+)?)/i, "");
    text = text.replace(/^(implement(s|ed|ing)?\s+(a\s+|an\s+)?)/i, "");
    text = text.replace(/^(create(s|d|ing)?\s+(a\s+|an\s+)?)/i, "");
    text = text.replace(/^(support(s|ed|ing)?\s+(for\s+)?)/i, "");
  } else if (type === "refactor") {
    text = text.replace(/^(refactor(s|ed|ing)?\s+(the\s+)?)/i, "");
    text = text.replace(/^(clean\s*up\s+(the\s+)?)/i, "");
    text = text.replace(/^(reorganize(s|d|ing)?\s+(the\s+)?)/i, "");
  } else if (type === "test") {
    text = text.replace(/^(add\s+tests?\s+(for\s+)?|write\s+tests?\s+(for\s+)?|test(s|ed|ing)?\s+)/i, "");
  }

  // Remove leading punctuation and trim
  text = text.trim().replace(/^[:\-\s]+/, "").replace(/[.;!?]+$/, "").replace(/\s+/g, " ");

  // Ensure first character is lowercase (standard conventional commits)
  if (text.length > 0) {
    text = text.charAt(0).toLowerCase() + text.slice(1);
  }

  // Truncate at word boundary if too long (max ~52 chars for subject so type+scope+subject <= 72)
  const maxLen = 52;
  if (text.length > maxLen) {
    const slice = text.slice(0, maxLen);
    const lastSpace = slice.lastIndexOf(" ");
    if (lastSpace > 20) {
      text = slice.slice(0, lastSpace);
    } else {
      text = slice;
    }
  }

  // Clean trailing prepositions or conjunctions after truncation (e.g., "instructions and")
  text = text.replace(TRAILING_DANGLING_WORDS_REGEX, "").trim();

  return text;
}

function fallbackSubjectFromFiles(type: string, changedFiles: string[]): string {
  if (changedFiles.length === 0) {
    return type === "fix" ? "bug fixes and improvements" : "code modifications";
  }

  const baseNames = changedFiles.map((f) => f.split("/").pop() || f);
  if (baseNames.length === 1 && baseNames[0]) {
    return `update ${baseNames[0]}`;
  }

  if (baseNames.length <= 3) {
    return `update ${baseNames.join(", ")}`;
  }

  return `update ${baseNames.slice(0, 2).join(", ")} and related files`;
}

/**
 * Formats a clean Conventional Commit title
 */
export function formatConventionalTitle(type: string, scope: string | undefined, subject: string): string {
  if (scope && scope.toLowerCase() !== type.toLowerCase()) {
    return `${type}(${scope}): ${subject}`;
  }
  return `${type}: ${subject}`;
}

/**
 * Generates high quality Conventional Commit title and commit message using the hybrid approach.
 */
export async function generatePullRequestMetadata(options: {
  sandbox: SandboxRunner;
  prompt: string;
  baseBranch: string;
  workingBranch?: string;
  finalDiff?: string;
}): Promise<PullRequestMetadata> {
  const { sandbox, prompt, baseBranch } = options;

  // 1. Capture changed files list and diffstat
  let changedFiles: string[] = [];
  let diffStat: string | undefined;

  try {
    const filesResult = await sandbox.exec(
      `git diff --name-only "${baseBranch}...HEAD"`,
      { cwd: "/workspace" },
    );
    if (filesResult.exitCode === 0 && filesResult.stdout.trim()) {
      changedFiles = filesResult.stdout.trim().split("\n").map((f) => f.trim()).filter(Boolean);
    } else {
      // Fallback: check uncommitted changes or working tree
      const statusResult = await sandbox.exec("git status --porcelain", { cwd: "/workspace" });
      if (statusResult.exitCode === 0 && statusResult.stdout.trim()) {
        changedFiles = statusResult.stdout
          .trim()
          .split("\n")
          .map((line) => line.slice(3).trim())
          .filter(Boolean);
      }
    }

    const statResult = await sandbox.exec(
      `git diff --stat "${baseBranch}...HEAD"`,
      { cwd: "/workspace" },
    );
    if (statResult.exitCode === 0 && statResult.stdout.trim()) {
      diffStat = statResult.stdout.trim();
    }
  } catch {
    // Non-fatal if git diff execution fails
  }

  // 2. Check if agent wrote /tmp/.pr_title or /tmp/.pr_title.txt
  try {
    const titleFileResult = await sandbox.exec(
      "cat /tmp/.pr_title 2>/dev/null || cat /tmp/.pr_title.txt 2>/dev/null",
      { cwd: "/workspace" },
    );
    if (titleFileResult.exitCode === 0 && titleFileResult.stdout.trim()) {
      const firstLine = titleFileResult.stdout.trim().split("\n")[0];
      const candidate = (firstLine ?? "").trim();
      if (candidate.length >= 8 && !isGenericCommitMessage(candidate)) {
        return {
          title: candidate,
          commitMessage: candidate,
          changedFiles,
          diffStat,
        };
      }
    }
  } catch {
    // Continue to next tier
  }

  // 3. Check if the agent created descriptive commits on the working branch
  try {
    const logResult = await sandbox.exec(
      `git log "${baseBranch}..HEAD" --format="%s" -n 5`,
      { cwd: "/workspace" },
    );
    if (logResult.exitCode === 0 && logResult.stdout.trim()) {
      const commitSubjects = logResult.stdout
        .trim()
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);

      for (const subject of commitSubjects) {
        if (!isGenericCommitMessage(subject) && subject.length >= 10) {
          return {
            title: subject,
            commitMessage: subject,
            changedFiles,
            diffStat,
          };
        }
      }
    }
  } catch {
    // Continue to heuristic generation
  }

  // 4. Fallback: Semantic Intent & Diff Scope Heuristics
  const type = detectCommitType(prompt, changedFiles);
  const scope = detectScope(changedFiles);
  let subject = cleanPromptSubject(prompt, type);

  if (!subject || subject.length < 3) {
    subject = fallbackSubjectFromFiles(type, changedFiles);
  }

  const title = formatConventionalTitle(type, scope, subject);

  return {
    title,
    commitMessage: title,
    changedFiles,
    diffStat,
  };
}
