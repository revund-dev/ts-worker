// Suggestion verification. Type-checks a proposed patched file
// against the project and reports whether the patch introduces
// new diagnostics relative to the baseline content.
//
// Entirely in memory: the patched text is swapped into the
// cached ts-morph project's source file, diagnostics are read
// from the type checker, and the original text is restored.
// Nothing is written to the clone and no repo code is executed
// (the type checker never emits or runs anything).
//
// "Best effort" by design: a missing project/file returns
// { verified: false }, which callers treat as "not checked" —
// never as a rejection.

import { existsSync } from "node:fs";
import { resolve, relative } from "node:path";
import { SourceFile, ts } from "ts-morph";

import { getProject } from "./utils/project";
import type { TscDiagnostic } from "./diagnostics";

export interface VerifyArgs {
  repoPath: string;
  file: string;
  originalContent: string;
  patchedContent: string;
}

export interface VerifyResult {
  verified: boolean;
  ok: boolean;
  newDiagnostics: TscDiagnostic[];
}

const MAX_NEW_DIAGNOSTICS = 20;
const UNVERIFIED: VerifyResult = { verified: false, ok: false, newDiagnostics: [] };

// Verification mutates the cached project's source file text, so
// concurrent calls for the same worker must not interleave. A
// promise chain serializes them; checks are short and rare
// (one per posted suggestion), so head-of-line blocking is fine.
let queue: Promise<unknown> = Promise.resolve();

export function verifySuggestion(args: VerifyArgs): Promise<VerifyResult> {
  const run = queue.then(() => verifyOnce(args));
  queue = run.catch(() => undefined);
  return run;
}

function verifyOnce(args: VerifyArgs): VerifyResult {
  if (!args.repoPath || !existsSync(args.repoPath) || !args.file) {
    return UNVERIFIED;
  }
  try {
    const project = getProject(args.repoPath);
    const absPath = resolve(args.repoPath, args.file);
    let sourceFile = project.getSourceFile(absPath);
    if (!sourceFile && existsSync(absPath)) {
      sourceFile = project.addSourceFileAtPath(absPath);
    }
    if (!sourceFile) {
      return UNVERIFIED;
    }

    const diskText = sourceFile.getFullText();
    try {
      if (diskText !== args.originalContent) {
        sourceFile.replaceWithText(args.originalContent);
      }
      const baseline = diagnosticsFor(sourceFile, args.repoPath);

      sourceFile.replaceWithText(args.patchedContent);
      const patched = diagnosticsFor(sourceFile, args.repoPath);

      const newDiagnostics = newRelativeToBaseline(baseline, patched);
      return {
        verified: true,
        ok: newDiagnostics.length === 0,
        newDiagnostics: newDiagnostics.slice(0, MAX_NEW_DIAGNOSTICS),
      };
    } finally {
      // Restore the on-disk text so the cached project stays
      // truthful for Parse/ResolveSymbols. Never save.
      if (sourceFile.getFullText() !== diskText) {
        sourceFile.replaceWithText(diskText);
      }
    }
  } catch {
    return UNVERIFIED;
  }
}

// diagnosticsFor reads syntactic + semantic diagnostics for one
// file from the program. Declaration/global diagnostics are
// excluded: they don't describe this file's patch.
function diagnosticsFor(sourceFile: SourceFile, repoPath: string): TscDiagnostic[] {
  const program = sourceFile.getProject().getProgram().compilerObject;
  const compilerFile = sourceFile.compilerNode;
  const raw: readonly ts.Diagnostic[] = [
    ...program.getSyntacticDiagnostics(compilerFile),
    ...program.getSemanticDiagnostics(compilerFile),
  ];
  const rel = relative(repoPath, compilerFile.fileName);
  return raw.map((d) => {
    let line = 0;
    let col = 0;
    if (d.start !== undefined) {
      const pos = compilerFile.getLineAndCharacterOfPosition(d.start);
      line = pos.line + 1;
      col = pos.character + 1;
    }
    return {
      file: rel.startsWith("..") ? compilerFile.fileName : rel,
      line,
      col,
      code: `TS${d.code}`,
      message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
    };
  });
}

// Diagnostics are compared as a multiset keyed by code+message
// (not position): a patch on an earlier line shifts every later
// diagnostic down, and a pre-existing error must not look "new"
// just because it moved.
export function newRelativeToBaseline(
  baseline: TscDiagnostic[],
  patched: TscDiagnostic[],
): TscDiagnostic[] {
  const remaining = new Map<string, number>();
  for (const d of baseline) {
    const key = `${d.code}:${d.message}`;
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  const out: TscDiagnostic[] = [];
  for (const d of patched) {
    const key = `${d.code}:${d.message}`;
    const count = remaining.get(key) ?? 0;
    if (count > 0) {
      remaining.set(key, count - 1);
    } else {
      out.push(d);
    }
  }
  return out;
}
