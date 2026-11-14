// Self-fetch clones of different tenants share one cache dir. The resolver
// returns declaration SOURCE TEXT, so it must never reach outside the repo.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveSymbols } from "../resolver";

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

const diff = (file: string, line: string) =>
  `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -0,0 +1,2 @@\n+${line}\n`;

test("resolves in-repo declarations", async () => {
  const repo = mkdtempSync(join(tmpdir(), "revund-rev17-res-"));
  write(join(repo, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }));
  write(join(repo, "src", "helpers.ts"), "export function inRepoHelper(n: number) { return n + 1; }\n");
  write(join(repo, "src", "main.ts"), 'import { inRepoHelper } from "./helpers";\nexport const v = inRepoHelper(1);\n');

  const decls = await resolveSymbols({ repoPath: repo, diff: diff("src/main.ts", "export const v = inRepoHelper(1);"), changedFiles: ["src/main.ts"] });
  assert.ok(decls.some((d) => d.name === "inRepoHelper" && d.filePath === join("src", "helpers.ts")), JSON.stringify(decls));
});

test("never returns a sibling tenant's or host file's source", async () => {
  const cache = mkdtempSync(join(tmpdir(), "revund-rev17-cache-"));
  const repo = join(cache, "tenant-a");
  const other = join(cache, "tenant-b");
  const host = mkdtempSync(join(tmpdir(), "revund-rev17-host-"));
  write(join(other, "src", "billing.ts"), "export function otherTenantBilling() { return 'TENANT_B_SOURCE'; }\n");
  write(join(host, "x.ts"), "export function hostThing() { return 'HOST_SOURCE'; }\n");
  write(join(repo, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true }, include: ["src", `${host}/**/*`] }));
  mkdirSync(join(repo, "src"), { recursive: true });
  symlinkSync(join(host, "x.ts"), join(repo, "src", "link.ts"));
  const line = "export const v = [otherTenantBilling(), hostThing()];";
  write(
    join(repo, "src", "main.ts"),
    `import { otherTenantBilling } from "../../tenant-b/src/billing";\nimport { hostThing } from "./link";\n${line}\n`,
  );

  const decls = await resolveSymbols({ repoPath: repo, diff: diff("src/main.ts", line), changedFiles: ["src/main.ts"] });
  const blob = JSON.stringify(decls);
  assert.ok(!blob.includes("TENANT_B_SOURCE"), `sibling tenant source leaked: ${blob}`);
  assert.ok(!blob.includes("HOST_SOURCE"), `host source leaked: ${blob}`);
});
