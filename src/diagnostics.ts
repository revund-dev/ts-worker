// Type-check driver. Runs the worker's bundled TypeScript against the
// repo and returns structured diagnostics filtered to the changed files.
//
// SECURITY (REV-17): this never executes anything from the reviewed repo.
// The old driver ran `<repo>/node_modules/.bin/tsc` — a file any PR author
// can commit — and otherwise `npx --yes tsc`, which downloads and runs
// whatever npm calls `tsc`. Now:
//
//   - the compiler is the `typescript` bundled inside ts-morph (a worker
//     dependency), driven through the compiler API in tsc-runner.ts
//   - the runner is forked with a scrubbed env (no worker secret, no
//     NODE_OPTIONS) and cwd outside the repo, killed after TSC_TIMEOUT_MS
//   - tsconfig plugins, emit and build info are stripped in the runner
//
// Per the contract, this NEVER returns an RPC error. If the runner fails
// or times out we return an empty array — degraded mode, review still ships.

import { fork } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, relative, isAbsolute, resolve } from "node:path";
import type { RawDiagnostic } from "./tsc-runner";
import { scrubbedEnv } from "./utils/sandbox";

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

  // The runner reports realpaths (macOS /var → /private/var, symlinked
  // cache dirs); normalise against the same root.
  const root = realpathSync(args.repoPath);
  const raw = await runChecker(root);
  if (raw === null) return [];

  const filterSet = new Set(args.filterFiles.map((f) => normalize(args.repoPath, f)));
  const out: TscDiagnostic[] = [];
  for (const d of raw) {
    const file = normalize(root, d.file);
    if (isAbsolute(file) || file.startsWith("..")) continue; // outside the repo
    if (filterSet.size > 0 && !filterSet.has(file)) continue;
    out.push({ ...d, file });
    if (out.length >= MAX_DIAGNOSTICS) break;
  }
  return out;
}

// runChecker forks tsc-runner (same extension as this module, so dev mode
// under tsx keeps working) and waits for its single IPC reply. Returns null on crash, timeout or runner error.
function runChecker(repoPath: string): Promise<RawDiagnostic[] | null> {
  const runner = join(__dirname, `tsc-runner${extname(__filename)}`);
  return new Promise((resolveP) => {
    let settled = false;
    const done = (v: RawDiagnostic[] | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveP(v);
    };
    let child: ReturnType<typeof fork>;
    try {
      child = fork(runner, [repoPath], {
        cwd: tmpdir(),
        env: scrubbedEnv(),
        // Compiled .js needs no loader; only dev mode (.ts under tsx)
        // inherits execArgv. Inheriting bare `--import x` flags would also
        // break, since they resolve against the child's cwd.
        execArgv: extname(runner) === ".ts" ? process.execArgv : [],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
    } catch {
      resolveP(null);
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(null);
    }, TSC_TIMEOUT_MS);
    child.stderr?.resume();
    child.on("message", (msg: { ok: boolean; diagnostics?: RawDiagnostic[] }) => {
      done(msg.ok && Array.isArray(msg.diagnostics) ? msg.diagnostics : null);
    });
    child.on("error", () => done(null));
    child.on("exit", () => done(null));
  });
}

function normalize(repoPath: string, file: string): string {
  if (isAbsolute(file)) {
    const rel = relative(repoPath, file);
    return rel.startsWith("..") ? file : rel;
  }
  // Already relative — make sure it's relative to repoPath, not CWD.
  return relative(repoPath, resolve(repoPath, file));
}
