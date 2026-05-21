// `tsc --noEmit` driver. Spawns the project's tsc, parses output, returns
// structured diagnostics filtered to the changed files.
//
// Resolution order for the tsc binary, picking the first that exists:
//   1. <repoPath>/node_modules/.bin/tsc — the project's pinned version, ideal.
//   2. `npx tsc` — works without an explicit install but adds latency.
//
// Per the contract, this NEVER returns an RPC error. If tsc isn't found or
// crashes, we return an empty array. The pass simply has no diagnostics to
// reason about — degraded mode, but the review still ships.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative, isAbsolute, resolve } from "node:path";

export interface TscDiagnostic {
  file: string;
  line: number;
  col: number;
  code: string;
  message: string;
}

export interface DiagnosticsArgs {
  repoPath: string;
  filterFiles: string[];
}

// Hard cap. tsc on a broken project can emit thousands of errors; we never
// want to ship more context than the LLM can absorb.
const MAX_DIAGNOSTICS = 200;

// tsc can take a while on large projects; refuse to run forever.
const TSC_TIMEOUT_MS = 30_000;

export async function runDiagnostics(args: DiagnosticsArgs): Promise<TscDiagnostic[]> {
  if (!args.repoPath || !existsSync(args.repoPath)) return [];

  const tscBin = join(args.repoPath, "node_modules", ".bin", "tsc");
  let cmd: string;
  let cmdArgs: string[];
  if (existsSync(tscBin)) {
    cmd = tscBin;
    cmdArgs = ["--noEmit", "--pretty", "false"];
  } else {
    cmd = "npx";
    cmdArgs = ["--yes", "tsc", "--noEmit", "--pretty", "false"];
  }

  const stdout = await runOnce(cmd, cmdArgs, args.repoPath);
  if (stdout === null) return [];

  const filterSet = new Set(args.filterFiles.map((f) => normalize(args.repoPath, f)));
  const out: TscDiagnostic[] = [];
  for (const line of stdout.split("\n")) {
    const d = parseTscLine(line, args.repoPath);
    if (!d) continue;
    if (filterSet.size > 0 && !filterSet.has(d.file)) continue;
    out.push(d);
    if (out.length >= MAX_DIAGNOSTICS) break;
  }
  return out;
}

// runOnce returns the merged stdout/stderr of the command, or null on any
// failure short of an actual diagnostic-bearing exit. tsc exits non-zero
// when it finds errors — that's a SUCCESS for our purposes — so we treat
// non-zero as "we got output worth parsing."
async function runOnce(cmd: string, args: string[], cwd: string): Promise<string | null> {
  return new Promise((resolveP) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolveP(null);
    }, TSC_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveP(null);
    });
    child.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // tsc writes diagnostics to stdout, occasionally also stderr. Merge.
      resolveP(stdout + stderr);
    });
  });
}

// parseTscLine handles the standard tsc --pretty=false format:
//   src/foo.ts(12,5): error TS2345: message text
// Returns null on lines that aren't diagnostics (summary "Found N errors", etc.)
function parseTscLine(line: string, repoPath: string): TscDiagnostic | null {
  const re = /^(.+?)\((\d+),(\d+)\):\s+(?:error|warning)\s+(TS\d+):\s+(.+)$/;
  const m = re.exec(line);
  if (!m) return null;
  const [, file, lineStr, colStr, code, message] = m;
  const lineNum = Number(lineStr);
  const colNum = Number(colStr);
  if (!Number.isFinite(lineNum) || !Number.isFinite(colNum) || !file || !code || !message) {
    return null;
  }
  return {
    file: normalize(repoPath, file),
    line: lineNum,
    col: colNum,
    code,
    message,
  };
}

function normalize(repoPath: string, file: string): string {
  if (isAbsolute(file)) {
    const rel = relative(repoPath, file);
    return rel.startsWith("..") ? file : rel;
  }
  // Already relative — make sure it's relative to repoPath, not CWD.
  return relative(repoPath, resolve(repoPath, file));
}
