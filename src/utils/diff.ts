// Tiny unified-diff helpers: extract changed file paths and the set of
// referenced identifiers from `+` lines. Identifier extraction is
// deliberately approximate — we collect every JavaScript-ish identifier
// in added lines, then the resolver narrows down to ones that are
// referenced but not declared in the changed file itself.

export function changedFilesFromDiff(diff: string): string[] {
  const out = new Set<string>();
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const raw = line.slice(4).trim();
      if (raw === "/dev/null") continue;
      const path = raw.startsWith("a/") || raw.startsWith("b/") ? raw.slice(2) : raw;
      out.add(path);
    }
  }
  return [...out];
}

// Identifiers we intentionally never look up: language keywords, common
// type names, and the JS standard library globals. The resolver would
// reject these later, but skipping them here saves time.
const SKIP = new Set<string>([
  // keywords / reserved
  "const", "let", "var", "function", "class", "interface", "type", "enum",
  "if", "else", "for", "while", "do", "switch", "case", "default", "break",
  "continue", "return", "throw", "try", "catch", "finally", "new", "delete",
  "typeof", "instanceof", "void", "in", "of", "as", "is", "this", "super",
  "import", "export", "from", "default", "extends", "implements", "static",
  "public", "private", "protected", "readonly", "abstract", "async", "await",
  "yield", "true", "false", "null", "undefined",
  // primitives + common types
  "string", "number", "boolean", "any", "unknown", "never", "object",
  "Array", "Promise", "Map", "Set", "Date", "RegExp", "Error", "JSON",
  "Math", "Object", "String", "Number", "Boolean", "Symbol",
  // common globals
  "console", "process", "Buffer", "globalThis", "window", "document",
]);

const IDENT_RE = /\b([A-Za-z_$][\w$]*)\b/g;

export function referencedIdentifiers(diff: string): Set<string> {
  const out = new Set<string>();
  for (const line of diff.split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    let m: RegExpExecArray | null;
    IDENT_RE.lastIndex = 0;
    while ((m = IDENT_RE.exec(line)) !== null) {
      const id = m[1];
      if (id && !SKIP.has(id)) {
        out.add(id);
      }
    }
  }
  return out;
}
