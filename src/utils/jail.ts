// Path jail for anything that reads a cloned repo. Self-fetch clones of
// different tenants share one cache dir, and a PR controls `../` imports,
// tsconfig `include`/`extends`, and committed symlinks — so every read
// must be checked against the repo's realpath, not just its spelling.

import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

// makeJail returns a predicate: is `p` (after resolving symlinks) inside
// root? `root` must already be a realpath. Always compares realpaths — a
// lexical shortcut would wrongly reject aliases of root (macOS /var →
// /private/var) — and caches per path since module resolution probes a lot.
export function makeJail(root: string): (p: string) => boolean {
  const cache = new Map<string, boolean>();
  const under = (p: string): boolean => {
    const rel = relative(root, p);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  return (p: string): boolean => {
    const abs = resolve(root, p);
    let hit = cache.get(abs);
    if (hit === undefined) {
      try {
        hit = under(realpathSync(abs));
      } catch {
        hit = false; // nonexistent → nothing to read anyway
      }
      cache.set(abs, hit);
    }
    return hit;
  };
}
