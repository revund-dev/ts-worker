// Symbol resolution. Given a diff and a repo path, return declarations of
// external symbols referenced in changed code but defined elsewhere — so the
// LLM passes can reason about a function call without us shipping the entire
// codebase as context.
//
// Algorithm:
//   1. Load (or fetch from cache) the ts-morph Project for repo_path.
//   2. Build a set of identifiers referenced in `+` lines of the diff.
//   3. For each changed source file: collect identifiers it DECLARES locally
//      (function/class/var/import). These are subtracted from the referenced
//      set — we only want externally-defined names.
//   4. For each remaining external identifier: ask ts-morph for the symbol
//      and walk to the declaration. Record file path + line range + source.
//
// "Best effort" by design: missing tsconfig, unresolvable identifiers, and
// stdlib refs are silently skipped — partial resolution is valid.

import { resolve, relative, isAbsolute } from "node:path";
import { existsSync } from "node:fs";
import {
  Node,
  SourceFile,
  SyntaxKind,
} from "ts-morph";

import { getProject } from "./utils/project";
import { changedFilesFromDiff, referencedIdentifiers } from "./utils/diff";

export interface SymbolDecl {
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  text: string;
}

export interface ResolveArgs {
  repoPath: string;
  diff: string;
  changedFiles: string[];
}

// Cap: a single review never returns more than this many declarations.
// Prevents pathological cases (huge file, every identifier is external)
// from blowing the LLM context budget.
const MAX_SYMBOLS = 40;

// Cap: a single declaration source body, in characters. Long classes are
// truncated; the resolver attaches a short marker so the LLM knows.
const MAX_DECL_TEXT = 2_000;

export async function resolveSymbols(args: ResolveArgs): Promise<SymbolDecl[]> {
  if (!args.repoPath || !existsSync(args.repoPath)) {
    return [];
  }

  const project = getProject(args.repoPath);

  const changedFiles = args.changedFiles.length > 0
    ? args.changedFiles
    : changedFilesFromDiff(args.diff);

  const referenced = referencedIdentifiers(args.diff);
  if (referenced.size === 0) {
    return [];
  }

  const localIdents = collectLocalIdentifiers(project, args.repoPath, changedFiles);
  const external = new Set([...referenced].filter((id) => !localIdents.has(id)));

  const seen = new Set<string>();
  const out: SymbolDecl[] = [];

  for (const id of external) {
    if (out.length >= MAX_SYMBOLS) break;

    const decl = findDeclaration(project, args.repoPath, changedFiles, id);
    if (!decl) continue;
    const key = `${decl.filePath}:${decl.startLine}:${decl.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(decl);
  }

  return out;
}

// collectLocalIdentifiers gathers every name a changed file DECLARES locally —
// functions, classes, interfaces, type aliases, const/let/var. Imports are
// deliberately excluded: an imported name points to an external symbol by
// definition, which is exactly what we want the resolver to chase down.
function collectLocalIdentifiers(
  project: ReturnType<typeof getProject>,
  repoPath: string,
  changedFiles: string[],
): Set<string> {
  const out = new Set<string>();
  for (const rel of changedFiles) {
    const sf = sourceFileFor(project, repoPath, rel);
    if (!sf) continue;

    sf.getFunctions().forEach((fn) => {
      const n = fn.getName();
      if (n) out.add(n);
    });
    sf.getClasses().forEach((cls) => {
      const n = cls.getName();
      if (n) out.add(n);
    });
    sf.getInterfaces().forEach((i) => out.add(i.getName()));
    sf.getTypeAliases().forEach((t) => out.add(t.getName()));
    sf.getEnums().forEach((e) => out.add(e.getName()));
    sf.getVariableDeclarations().forEach((v) => out.add(v.getName()));
  }
  return out;
}

// findDeclaration walks the project for a top-level declaration named `id`.
// Skips matches inside the changed files themselves — those aren't external.
function findDeclaration(
  project: ReturnType<typeof getProject>,
  repoPath: string,
  changedFiles: string[],
  id: string,
): SymbolDecl | null {
  const changedAbs = new Set(changedFiles.map((f) => resolve(repoPath, f)));

  for (const sf of project.getSourceFiles()) {
    const filePath = sf.getFilePath();
    if (changedAbs.has(filePath)) continue;
    if (filePath.includes("/node_modules/")) continue;

    const decl =
      findNamed(sf, id, SyntaxKind.FunctionDeclaration) ??
      findNamed(sf, id, SyntaxKind.ClassDeclaration) ??
      findNamed(sf, id, SyntaxKind.InterfaceDeclaration) ??
      findNamed(sf, id, SyntaxKind.TypeAliasDeclaration) ??
      findNamed(sf, id, SyntaxKind.EnumDeclaration) ??
      findVariable(sf, id);

    if (!decl) continue;

    const start = decl.getStartLineNumber();
    const end = decl.getEndLineNumber();
    let text = decl.getText();
    if (text.length > MAX_DECL_TEXT) {
      text = text.slice(0, MAX_DECL_TEXT) + "\n// … truncated";
    }

    let rel = isAbsolute(filePath) ? relative(repoPath, filePath) : filePath;
    if (rel.startsWith("../")) rel = filePath; // outside the repo — leave absolute

    return {
      name: id,
      filePath: rel,
      startLine: start,
      endLine: end,
      text,
    };
  }
  return null;
}

function findNamed(sf: SourceFile, name: string, kind: SyntaxKind): Node | undefined {
  for (const node of sf.getDescendantsOfKind(kind)) {
    const n = (node as Node & { getName?: () => string | undefined }).getName?.();
    if (n === name) return node;
  }
  return undefined;
}

function findVariable(sf: SourceFile, name: string): Node | undefined {
  for (const v of sf.getVariableDeclarations()) {
    if (v.getName() === name) {
      // Return the parent statement so the snippet captures `export const X = …`
      // rather than just the binding.
      return v.getVariableStatement() ?? v;
    }
  }
  return undefined;
}

function sourceFileFor(
  project: ReturnType<typeof getProject>,
  repoPath: string,
  relPath: string,
): SourceFile | undefined {
  const absPath = resolve(repoPath, relPath);
  let sf = project.getSourceFile(absPath);
  if (sf) return sf;
  if (existsSync(absPath)) {
    sf = project.addSourceFileAtPathIfExists(absPath);
    if (sf) return sf;
  }
  return undefined;
}
