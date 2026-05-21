// Project cache. ts-morph Project initialization is expensive (~800ms cold
// for a real repo). Cache one Project per repo path; invalidate when
// tsconfig.json's mtime changes so config edits are picked up without
// restarting the worker.

import { statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Project } from "ts-morph";

interface Cached {
  project: Project;
  tsconfigMtimeMs: number;
}

const cache = new Map<string, Cached>();

export function getProject(repoPath: string): Project {
  const tsconfigPath = join(repoPath, "tsconfig.json");
  const hasTsconfig = existsSync(tsconfigPath);
  const mtime = hasTsconfig ? statSync(tsconfigPath).mtimeMs : 0;

  const existing = cache.get(repoPath);
  if (existing && existing.tsconfigMtimeMs === mtime) {
    return existing.project;
  }

  // No tsconfig → spin up an in-memory project so callers still get a
  // Project to traverse. Symbol resolution will be best-effort across
  // the changed files only.
  const project = hasTsconfig
    ? new Project({ tsConfigFilePath: tsconfigPath, skipAddingFilesFromTsConfig: false })
    : new Project({ useInMemoryFileSystem: false });

  cache.set(repoPath, { project, tsconfigMtimeMs: mtime });
  return project;
}
