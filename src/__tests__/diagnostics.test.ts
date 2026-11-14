// REV-17 regression suite: the worker must never execute code that comes
// from the repository it is reviewing. Each fixture plants a payload that
// writes a marker file if it ever runs; every test asserts the marker is
// absent while diagnostics still come back from the worker's bundled
// TypeScript.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runDiagnostics } from "../diagnostics";

interface Fixture {
  repo: string;
  marker: string;
}

function write(path: string, content: string, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  chmodSync(path, mode);
}

function payload(marker: string): string {
  return `#!/bin/sh\necho pwned >> "${marker}"\n`;
}

// A repo with a real type error, so we can prove diagnostics still work.
function fixture(tsconfig: object = { compilerOptions: { strict: true, noEmit: true } }): Fixture {
  const root = mkdtempSync(join(tmpdir(), "revund-rev17-"));
  const repo = join(root, "repo");
  const marker = join(root, "pwned");
  write(join(repo, "tsconfig.json"), JSON.stringify(tsconfig));
  write(join(repo, "src", "bad.ts"), 'export const n: number = "not a number";\n');
  return { repo, marker };
}

function assertNotPwned(fx: Fixture): void {
  assert.equal(existsSync(fx.marker), false, "code from the reviewed repo was executed");
}

function assertFoundTypeError(diags: Awaited<ReturnType<typeof runDiagnostics>>): void {
  const hit = diags.find((d) => d.file === join("src", "bad.ts") && d.code === "TS2322");
  assert.ok(hit, `expected TS2322 in src/bad.ts, got ${JSON.stringify(diags)}`);
  assert.equal(hit.line, 1);
}

test("never runs the repo's node_modules/.bin/tsc", async () => {
  const fx = fixture();
  write(join(fx.repo, "node_modules", ".bin", "tsc"), payload(fx.marker), 0o755);

  const diags = await runDiagnostics({ repoPath: fx.repo, filterFiles: [] });

  assertNotPwned(fx);
  assertFoundTypeError(diags);
});

test("never shells out to npx or a tsc on PATH", async () => {
  const fx = fixture();
  const evilBin = mkdtempSync(join(tmpdir(), "revund-rev17-bin-"));
  for (const name of ["npx", "tsc", "npm", "node_modules_tsc"]) {
    write(join(evilBin, name), payload(fx.marker), 0o755);
  }
  const savedPath = process.env.PATH;
  process.env.PATH = `${evilBin}:${savedPath ?? ""}`;
  try {
    const diags = await runDiagnostics({ repoPath: fx.repo, filterFiles: ["src/bad.ts"] });
    assertNotPwned(fx);
    assertFoundTypeError(diags);
  } finally {
    process.env.PATH = savedPath;
  }
});

test("ignores tsconfig plugins that point at repo code", async () => {
  const fx = fixture({
    compilerOptions: {
      strict: true,
      plugins: [{ name: "evil-plugin" }, { transform: "./evil-transform.js" }],
    },
  });
  const js = `require("fs").appendFileSync(${JSON.stringify(fx.marker)}, "pwned");\nmodule.exports = () => ({ create: (i) => i.languageService });\n`;
  write(join(fx.repo, "node_modules", "evil-plugin", "package.json"), '{"name":"evil-plugin","main":"index.js"}');
  write(join(fx.repo, "node_modules", "evil-plugin", "index.js"), js);
  write(join(fx.repo, "evil-transform.js"), js);

  const diags = await runDiagnostics({ repoPath: fx.repo, filterFiles: [] });

  assertNotPwned(fx);
  assertFoundTypeError(diags);
});

test("does not emit or write build info into the repo", async () => {
  const fx = fixture({
    compilerOptions: { strict: true, noEmit: false, outDir: "out", incremental: true, tsBuildInfoFile: "x.tsbuildinfo" },
  });
  await runDiagnostics({ repoPath: fx.repo, filterFiles: [] });
  assert.equal(existsSync(join(fx.repo, "out")), false, "emitted JS into the repo");
  assert.equal(existsSync(join(fx.repo, "x.tsbuildinfo")), false, "wrote tsbuildinfo into the repo");
});

test("drops diagnostics for files outside the repo", async () => {
  const fx = fixture();
  const outside = mkdtempSync(join(tmpdir(), "revund-rev17-outside-"));
  write(join(outside, "host.ts"), 'export const leaked: number = "host file";\n');
  write(
    join(fx.repo, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true }, include: ["src", `${outside}/**/*`] }),
  );

  const diags = await runDiagnostics({ repoPath: fx.repo, filterFiles: [] });

  assertFoundTypeError(diags);
  assert.ok(
    diags.every((d) => !d.file.includes("host.ts")),
    `out-of-repo file leaked: ${JSON.stringify(diags)}`,
  );
});

test("no tsconfig in the repo root → empty, no parent-dir lookup", async () => {
  const root = mkdtempSync(join(tmpdir(), "revund-rev17-"));
  // A tsconfig ABOVE the repo must not be picked up.
  write(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
  const repo = join(root, "repo");
  write(join(repo, "src", "bad.ts"), 'export const n: number = "x";\n');

  assert.deepEqual(await runDiagnostics({ repoPath: repo, filterFiles: [] }), []);
});

test("missing repo path → empty, never throws", async () => {
  assert.deepEqual(await runDiagnostics({ repoPath: "/nonexistent/revund", filterFiles: [] }), []);
});
