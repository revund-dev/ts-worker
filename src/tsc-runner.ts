// Child-process entry for RunDiagnostics. Forked by diagnostics.ts with a
// scrubbed env; replies with one IPC message and exits.
//
// Type-checks with the TypeScript compiler bundled inside ts-morph — the
// worker's own dependency — through the compiler API. Nothing is resolved
// from the reviewed repo except source and tsconfig JSON:
//
//   - no `node_modules/.bin/tsc`, no `npx`, no PATH lookup
//   - only `<repo>/tsconfig.json`, never a parent-dir search
//   - `plugins` stripped (tsserver-only today; stripped so a future API
//     change can't start honouring them), emit and build info disabled
//   - root files outside the repo (absolute `include`, symlinks) dropped
//
// Nothing in a tsconfig can make the compiler API execute code: `extends`
// and `references` load JSON / .d.ts, custom transformers are API-only.

import { existsSync, realpathSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { ts } from "ts-morph";

export interface RawDiagnostic {
  file: string; // absolute
  line: number;
  col: number;
  code: string;
  message: string;
}

export function checkRepo(repoPath: string): RawDiagnostic[] {
  const root = realpathSync(repoPath);
  const configPath = join(root, "tsconfig.json");
  if (!existsSync(configPath)) return [];

  const host: ts.ParseConfigFileHost = {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: () => undefined,
  };
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, undefined, host);
  if (!parsed) return [];

  const { plugins: _plugins, tsBuildInfoFile: _buildInfo, ...rest } = parsed.options;
  const options: ts.CompilerOptions = {
    ...rest,
    noEmit: true,
    emitDeclarationOnly: false,
    declaration: false,
    composite: false,
    incremental: false,
  };

  const inside = (f: string): boolean => {
    try {
      const rel = relative(root, realpathSync(f));
      return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
    } catch {
      return false;
    }
  };

  const program = ts.createProgram({
    rootNames: parsed.fileNames.filter(inside),
    options,
    ...(parsed.projectReferences ? { projectReferences: parsed.projectReferences } : {}),
  });

  const out: RawDiagnostic[] = [];
  for (const d of ts.getPreEmitDiagnostics(program)) {
    if (!d.file || d.start === undefined) continue;
    if (d.category !== ts.DiagnosticCategory.Error && d.category !== ts.DiagnosticCategory.Warning) continue;
    if (!inside(d.file.fileName)) continue;
    const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
    out.push({
      file: d.file.fileName,
      line: line + 1,
      col: character + 1,
      code: `TS${d.code}`,
      message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
    });
  }
  return out;
}

if (require.main === module) {
  const repoPath = process.argv[2] ?? "";
  let reply: { ok: true; diagnostics: RawDiagnostic[] } | { ok: false; error: string };
  try {
    reply = { ok: true, diagnostics: checkRepo(repoPath) };
  } catch (err) {
    reply = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  process.send?.(reply, () => process.exit(0));
}
