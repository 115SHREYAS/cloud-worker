"use client";

import { useMemo, useState } from "react";
import { FileCode, Copy, Check, GitCommit } from "lucide-react";

interface DiffViewerProps {
  diff: string;
}

interface ParsedFileDiff {
  header: string;
  fileName: string;
  additions: number;
  deletions: number;
  lines: Array<{
    type: "add" | "delete" | "hunk" | "context" | "meta";
    content: string;
  }>;
}

export function DiffViewer({ diff }: DiffViewerProps) {
  const [copied, setCopied] = useState(false);

  const parsedFiles = useMemo<ParsedFileDiff[]>(() => {
    if (!diff || !diff.trim()) return [];

    const files: ParsedFileDiff[] = [];
    const rawChunks = diff.split(/^diff --git /m).filter(Boolean);

    for (const chunk of rawChunks) {
      const fullChunk = `diff --git ${chunk}`;
      const rawLines = fullChunk.split("\n");

      // Extract file name
      const headerLine = rawLines[0] || "";
      const match = headerLine.match(/a\/(.+?)\s+b\/(.+)$/);
      const fileName = match ? match[2] || match[1] || "unknown" : "modified-file";

      let additions = 0;
      let deletions = 0;

      const lines = rawLines.map((line) => {
        if (line.startsWith("@@")) {
          return { type: "hunk" as const, content: line };
        }
        if (line.startsWith("+") && !line.startsWith("+++")) {
          additions += 1;
          return { type: "add" as const, content: line };
        }
        if (line.startsWith("-") && !line.startsWith("---")) {
          deletions += 1;
          return { type: "delete" as const, content: line };
        }
        if (
          line.startsWith("diff --git") ||
          line.startsWith("index ") ||
          line.startsWith("--- ") ||
          line.startsWith("+++ ")
        ) {
          return { type: "meta" as const, content: line };
        }
        return { type: "context" as const, content: line };
      });

      files.push({
        header: headerLine,
        fileName,
        additions,
        deletions,
        lines,
      });
    }

    return files;
  }, [diff]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(diff);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy diff:", err);
    }
  };

  if (!diff || !diff.trim() || parsedFiles.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center p-12 text-center text-zinc-500 rounded-xl border border-dashed border-zinc-800 bg-zinc-950/40">
        <GitCommit className="w-8 h-8 mb-3 text-zinc-600 animate-pulse" />
        <p className="text-sm font-medium text-zinc-400">No git changes committed yet.</p>
        <p className="text-xs text-zinc-600 mt-1">
          When the agent edits files and commits patches in the microVM, the live unified diff will appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Diff Controls Header */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-zinc-900 border border-zinc-800 rounded-lg text-xs">
        <div className="flex items-center gap-3">
          <span className="font-semibold text-zinc-300">
            {parsedFiles.length} {parsedFiles.length === 1 ? "file" : "files"} modified
          </span>
          <span className="text-zinc-500">•</span>
          <span className="text-emerald-400 font-mono">
            +{parsedFiles.reduce((acc, f) => acc + f.additions, 0)} additions
          </span>
          <span className="text-rose-400 font-mono">
            -{parsedFiles.reduce((acc, f) => acc + f.deletions, 0)} deletions
          </span>
        </div>

        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 transition-colors cursor-pointer"
        >
          {copied ? (
            <>
              <Check className="w-3.5 h-3.5 text-emerald-400" />
              <span>Copied patch</span>
            </>
          ) : (
            <>
              <Copy className="w-3.5 h-3.5" />
              <span>Copy raw diff</span>
            </>
          )}
        </button>
      </div>

      {/* File Diffs */}
      <div className="space-y-4">
        {parsedFiles.map((file, fileIdx) => (
          <div
            key={`file-${fileIdx}`}
            className="rounded-lg border border-zinc-800 bg-zinc-950 overflow-hidden font-mono text-xs shadow-sm"
          >
            {/* File Header */}
            <div className="flex items-center justify-between px-4 py-2 bg-zinc-900/90 border-b border-zinc-800">
              <div className="flex items-center gap-2">
                <FileCode className="w-4 h-4 text-zinc-400" />
                <span className="font-semibold text-zinc-200">{file.fileName}</span>
              </div>
              <div className="flex items-center gap-2 text-[11px]">
                <span className="text-emerald-400">+{file.additions}</span>
                <span className="text-rose-400">-{file.deletions}</span>
              </div>
            </div>

            {/* Code Lines */}
            <div className="p-2 overflow-x-auto leading-relaxed">
              {file.lines.map((line, lineIdx) => {
                if (line.type === "meta") {
                  return (
                    <div key={`l-${lineIdx}`} className="text-zinc-600 px-2 py-0.5 select-none">
                      {line.content}
                    </div>
                  );
                }

                if (line.type === "hunk") {
                  return (
                    <div
                      key={`l-${lineIdx}`}
                      className="bg-cyan-950/40 text-cyan-300 font-semibold px-2 py-1 my-1 rounded"
                    >
                      {line.content}
                    </div>
                  );
                }

                if (line.type === "add") {
                  return (
                    <div
                      key={`l-${lineIdx}`}
                      className="bg-emerald-950/30 text-emerald-300 px-2 py-0.5"
                    >
                      {line.content}
                    </div>
                  );
                }

                if (line.type === "delete") {
                  return (
                    <div
                      key={`l-${lineIdx}`}
                      className="bg-rose-950/30 text-rose-300 px-2 py-0.5"
                    >
                      {line.content}
                    </div>
                  );
                }

                return (
                  <div key={`l-${lineIdx}`} className="text-zinc-400 px-2 py-0.5">
                    {line.content}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
