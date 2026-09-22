"use client";

import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Copy, Check, Trash2, ArrowDown } from "lucide-react";

interface TerminalViewProps {
  buffer: string;
  onClear?: () => void;
  status?: string;
}

export function TerminalView({ buffer, onClear, status }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const writtenLengthRef = useRef<number>(0);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;

    // Initialize xterm instance
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      fontSize: 13,
      lineHeight: 1.4,
      fontFamily: "var(--font-geist-mono), monospace",
      theme: {
        background: "#09090b", // zinc-950
        foreground: "#f4f4f5", // zinc-100
        cursor: "#22c55e", // emerald-500
        cursorAccent: "#09090b",
        selectionBackground: "#3f3f46", // zinc-700
        black: "#18181b",
        red: "#ef4444",
        green: "#22c55e",
        yellow: "#eab308",
        blue: "#3b82f6",
        magenta: "#ec4899",
        cyan: "#06b6d4",
        white: "#f4f4f5",
        brightBlack: "#71717a",
        brightRed: "#f87171",
        brightGreen: "#4ade80",
        brightYellow: "#fde047",
        brightBlue: "#60a5fa",
        brightMagenta: "#f472b6",
        brightCyan: "#22d3ee",
        brightWhite: "#ffffff",
      },
      convertEol: true,
      disableStdin: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    try {
      fitAddon.fit();
    } catch {
      // Ignore initial fit errors
    }

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;
    writtenLengthRef.current = 0;

    // Initial banner
    term.writeln("\x1b[90m┌──────────────────────────────────────────────────────────┐\x1b[0m");
    term.writeln("\x1b[90m│\x1b[0m \x1b[1;36mCloud Worker MicroVM Session\x1b[0m \x1b[90m|\x1b[0m \x1b[32mDirect In-Guest Stream\x1b[0m  \x1b[90m│\x1b[0m");
    term.writeln("\x1b[90m└──────────────────────────────────────────────────────────┘\x1b[0m\r\n");

    // Resize handling
    const resizeObserver = new ResizeObserver(() => {
      try {
        fitAddon.fit();
      } catch {
        // Ignore fit errors if element not visible
      }
    });

    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      term.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  // Write new chunks incrementally
  useEffect(() => {
    const term = terminalRef.current;
    if (!term) return;

    if (buffer.length < writtenLengthRef.current) {
      // Buffer was cleared or reset
      term.reset();
      writtenLengthRef.current = 0;
    }

    if (buffer.length > writtenLengthRef.current) {
      const newChunk = buffer.slice(writtenLengthRef.current);
      term.write(newChunk);
      writtenLengthRef.current = buffer.length;
    }
  }, [buffer]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(buffer);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy terminal buffer:", err);
    }
  };

  const handleScrollToBottom = () => {
    terminalRef.current?.scrollToBottom();
  };

  const handleClear = () => {
    terminalRef.current?.clear();
    if (onClear) onClear();
  };

  return (
    <div className="flex flex-col h-full rounded-xl border border-zinc-800 bg-zinc-950 overflow-hidden shadow-sm">
      {/* Terminal Toolbar */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-zinc-900/90 border-b border-zinc-800 text-xs text-zinc-400 select-none">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-rose-500/80 inline-block" />
            <span className="w-2.5 h-2.5 rounded-full bg-amber-500/80 inline-block" />
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500/80 inline-block" />
          </div>
          <span className="font-mono text-zinc-300 font-medium ml-2">xterm-output</span>
          {status && (
            <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-zinc-800 text-zinc-300">
              {status}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleScrollToBottom}
            title="Scroll to bottom"
            className="p-1.5 rounded hover:bg-zinc-800 hover:text-zinc-200 transition-colors cursor-pointer"
          >
            <ArrowDown className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={handleCopy}
            title="Copy terminal buffer"
            className="p-1.5 rounded hover:bg-zinc-800 hover:text-zinc-200 transition-colors cursor-pointer"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
          <button
            type="button"
            onClick={handleClear}
            title="Clear terminal"
            className="p-1.5 rounded hover:bg-zinc-800 hover:text-zinc-200 transition-colors cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Terminal Viewport */}
      <div ref={containerRef} className="flex-1 min-h-[360px] p-3 overflow-hidden" />
    </div>
  );
}
