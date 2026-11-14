import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitEnv, hardenedGitArgs, scrubbedEnv } from "../utils/sandbox";
import { fetchOrCache } from "../fetcher";

test("scrubbedEnv keeps the allow-list and drops secrets", () => {
  const saved = { ...process.env };
  try {
    process.env.REVUND_WORKER_SECRET = "worker-secret";
    process.env.GITHUB_APP_PRIVATE_KEY = "key";
    process.env.NODE_OPTIONS = "--require /tmp/evil.js";
    process.env.PATH = "/usr/bin";
    const env = scrubbedEnv({ EXTRA: "1" });
    assert.equal(env.REVUND_WORKER_SECRET, undefined);
    assert.equal(env.GITHUB_APP_PRIVATE_KEY, undefined);
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.EXTRA, "1");
  } finally {
    process.env = saved;
  }
});

test("git runs with hooks off and no host config", () => {
  const args = hardenedGitArgs(["status"]);
  assert.ok(args.includes("core.hooksPath=/dev/null"));
  assert.ok(args.includes("core.fsmonitor=false"));
  assert.equal(args.at(-1), "status");
  const env = gitEnv();
  assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
});

// End to end: a repo whose .gitattributes opts into a smudge filter that the
// host's git config defines. A naive clone+checkout runs the filter.
test("fetchOrCache never runs config-driven filters on checkout", () => {
  const root = mkdtempSync(join(tmpdir(), "revund-rev17-fetch-"));
  const marker = join(root, "pwned");
  const script = join(root, "payload.sh");
  writeFileSync(script, `#!/bin/sh\necho pwned >> "${marker}"\ncat\n`);
  chmodSync(script, 0o755);
  const globalCfg = join(root, "gitconfig");
  writeFileSync(
    globalCfg,
    `[filter "evil"]\n\tsmudge = ${script}\n\tclean = cat\n[user]\n\tname = t\n\temail = t@example.com\n`,
  );

  const upstream = join(root, "upstream");
  const git = (...a: string[]) =>
    execFileSync("git", ["-c", "filter.evil.smudge=cat", ...a], {
      cwd: upstream,
      env: { ...process.env, GIT_CONFIG_GLOBAL: globalCfg, GIT_CONFIG_NOSYSTEM: "1" },
      stdio: "pipe",
    });
  execFileSync("mkdir", ["-p", upstream]);
  git("init", "-q", "-b", "main");
  writeFileSync(join(upstream, ".gitattributes"), "* filter=evil\n");
  writeFileSync(join(upstream, "a.ts"), "export const a = 1;\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  assert.equal(existsSync(marker), false, "fixture setup ran the payload");

  const saved = { ...process.env };
  try {
    process.env.GIT_CONFIG_GLOBAL = globalCfg;
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    process.env.REVUND_WORKER_CACHE_DIR = join(root, "cache");
    const dir = fetchOrCache({ url: upstream, ref: "main", authToken: "" });
    assert.ok(existsSync(join(dir, "a.ts")), "checkout did not materialise files");
  } finally {
    process.env = saved;
  }
  assert.equal(existsSync(marker), false, "git ran a filter driver from host config");
});
