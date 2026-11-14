import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { verifySuggestion, newRelativeToBaseline } from "../verify";

const GREET =
  'export function greet(name: string): string {\n  return "hello " + name;\n}\n';

// writeFixture lays down a minimal TS project on disk — the
// worker reads the repo from the filesystem, only the patched
// content is in-memory.
function writeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "revund-verify-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { target: "ES2022", module: "CommonJS", strict: true },
      include: ["src"],
    }),
  );
  writeFileSync(join(dir, "src", "greet.ts"), GREET);
  return dir;
}

function patched(replacement: string): string {
  return GREET.replace('return "hello " + name;', replacement);
}

test("good suggestion passes", async () => {
  const repo = writeFixture();
  const result = await verifySuggestion({
    repoPath: repo,
    file: "src/greet.ts",
    originalContent: GREET,
    patchedContent: patched("return `hello ${name}`;"),
  });
  assert.equal(result.verified, true);
  assert.equal(result.ok, true);
  assert.deepEqual(result.newDiagnostics, []);
});

test("suggestion calling a non-existent method is rejected", async () => {
  const repo = writeFixture();
  const result = await verifySuggestion({
    repoPath: repo,
    file: "src/greet.ts",
    originalContent: GREET,
    patchedContent: patched("return name.wrapWithGreeting();"),
  });
  assert.equal(result.verified, true);
  assert.equal(result.ok, false);
  assert.ok(
    result.newDiagnostics.some((d) => d.message.includes("wrapWithGreeting")),
    `expected a diagnostic naming the hallucinated method, got ${JSON.stringify(result.newDiagnostics)}`,
  );
});

test("verification leaves the file on disk untouched", async () => {
  const repo = writeFixture();
  await verifySuggestion({
    repoPath: repo,
    file: "src/greet.ts",
    originalContent: GREET,
    patchedContent: patched("return name.wrapWithGreeting();"),
  });
  assert.equal(readFileSync(join(repo, "src", "greet.ts"), "utf8"), GREET);
});

test("missing file is unverified, not rejected", async () => {
  const repo = writeFixture();
  const result = await verifySuggestion({
    repoPath: repo,
    file: "src/nope.ts",
    originalContent: GREET,
    patchedContent: GREET,
  });
  assert.equal(result.verified, false);
  assert.equal(result.ok, false);
});

test("newRelativeToBaseline ignores pre-existing errors that only moved", () => {
  const d = (line: number, message: string) => ({
    file: "src/greet.ts",
    line,
    col: 1,
    code: "TS2322",
    message,
  });
  const baseline = [d(5, "Type 'number' is not assignable to type 'string'.")];
  const after = [d(9, "Type 'number' is not assignable to type 'string'.")];
  assert.deepEqual(newRelativeToBaseline(baseline, after), []);
});

test("newRelativeToBaseline counts repeated errors as a multiset", () => {
  const d = (line: number) => ({
    file: "src/greet.ts",
    line,
    col: 1,
    code: "TS2304",
    message: "Cannot find name 'foo'.",
  });
  const extra = newRelativeToBaseline([d(1)], [d(1), d(2)]);
  assert.equal(extra.length, 1);
  assert.equal(extra[0]?.line, 2);
});
