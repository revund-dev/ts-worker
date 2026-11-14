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
//
// Nothing in a tsconfig can make the compiler API execute code: `extends`
// and `references` load JSON / .d.ts, custom transformers are API-only.
//
// Reads are jailed to the repo. The compiler host refuses every path whose
// realpath is outside the repo root — `../` imports, absolute `include`,
// `extends`/`typeRoots`/`paths` pointing out, committed symlinks — and
// serves the standard lib from ts-morph's in-memory copy. Self-fetch clones
// of different tenants share one cache dir, so this is also what stops a
// PR from type-checking against (and leaking names from) a neighbour.

import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { makeJail } from "./utils/jail";

// Resolve @ts-morph/common from ts-morph's own location so we always get
// the copy ts-morph uses, whatever npm's hoisting did.
const common = require(
  require.resolve("@ts-morph/common", { paths: [dirname(require.resolve("ts-morph"))] }),
) as typeof import("@ts-morph/common");
const ts = common.ts;

const LIB_DIR: string = common.libFolderInMemoryPath;
const LIB_FILES = new Map<string, string>(
  common.getLibFiles().map((f: { fileName: string; text: string }) => [join(LIB_DIR, f.fileName), f.text]),
);

export interface RawDiagnostic {
  file: string; // absolute
  line: number;
  col: number;
  code: string;
  message: string;
}

function jailedHost(root: string) {
  const inside = makeJail(root);
  const isLib = (p: string): boolean => LIB_FILES.has(p);
  const isLibDir = (p: string): boolean => p === LIB_DIR || p.startsWith(LIB_DIR + "/");

  const fileExists = (p: string): boolean => isLib(p) || (inside(p) && ts.sys.fileExists(p));
  const readFile = (p: string): string | undefined =>
    LIB_FILES.get(p) ?? (inside(p) ? ts.sys.readFile(p) : undefined);
  const directoryExists = (p: string): boolean => isLibDir(p) || (inside(p) && ts.sys.directoryExists(p));
  const getDirectories = (p: string): string[] => (inside(p) ? ts.sys.getDirectories(p) : []);
  const readDirectory: typeof ts.sys.readDirectory = (p, ext, exc, inc, depth) =>
    inside(p) ? ts.sys.readDirectory(p, ext, exc, inc, depth).filter(inside) : [];
  const realpath = (p: string): string => (inside(p) ? realpathSync(p) : p);

  const configHost: import("@ts-morph/common").ts.ParseConfigFileHost = {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    getCurrentDirectory: () => root,
    fileExists,
    readFile,
    readDirectory,
    onUnRecoverableConfigFileDiagnostic: () => undefined,
  };

  const compilerHost: import("@ts-morph/common").ts.CompilerHost = {
    fileExists,
    readFile,
    directoryExists,
    getDirectories,
    realpath,
    getSourceFile: (fileName, languageVersion) => {
      const text = readFile(fileName);
      return text === undefined ? undefined : ts.createSourceFile(fileName, text, languageVersion);
    },
    getDefaultLibLocation: () => LIB_DIR,
    getDefaultLibFileName: (o) => join(LIB_DIR, ts.getDefaultLibFileName(o)),
    writeFile: () => undefined, // never write anything
    getCurrentDirectory: () => root,
    getCanonicalFileName: (f) => (ts.sys.useCaseSensitiveFileNames ? f : f.toLowerCase()),
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    getNewLine: () => "\n",
  };
  return { inside, configHost, compilerHost };
}

export function checkRepo(repoPath: string): RawDiagnostic[] {
  const root = realpathSync(repoPath);
  const configPath = join(root, "tsconfig.json");
  const { inside, configHost, compilerHost } = jailedHost(root);
  if (!configHost.fileExists(configPath)) return [];

  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, undefined, configHost);
  if (!parsed) return [];

  const { plugins: _plugins, tsBuildInfoFile: _buildInfo, ...rest } = parsed.options;
  const options = {
    ...rest,
    noEmit: true,
    emitDeclarationOnly: false,
    declaration: false,
    composite: false,
    incremental: false,
  };

  const program = ts.createProgram({
    rootNames: parsed.fileNames.filter(inside),
    options,
    host: compilerHost,
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
