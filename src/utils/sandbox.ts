// Guard rails for every subprocess the worker starts against a cloned PR.
// Mirrors core/pkg/sandbox — see docs/threat-model.md.
//
//   1. The reviewed repo never decides what code runs. git is invoked with
//      hooks, fsmonitor and host config switched off, so .gitattributes and
//      .git/hooks in the PR have nothing to trigger.
//   2. Subprocesses get an allow-listed env, never process.env. The worker
//      secret and anything else the operator put in our env stays here.

const ALLOW = new Set([
  "PATH", "HOME", "USER", "LOGNAME",
  "TMPDIR", "TMP", "TEMP",
  "LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "TZ",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  "SYSTEMROOT", "SystemRoot", "COMSPEC", "PATHEXT", "WINDIR",
]);

export function scrubbedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && ALLOW.has(k)) env[k] = v;
  }
  return { ...env, ...extra };
}

// `-c` overrides beat repo-local config, so even a cache entry with a
// tampered .git/config cannot switch these back on.
const GIT_CONFIG = [
  "core.hooksPath=/dev/null",
  "core.fsmonitor=false",
  "core.untrackedCache=false",
  "core.sshCommand=ssh",
  "core.pager=cat",
  "submodule.recurse=false",
  "protocol.ext.allow=never",
  "uploadpack.packObjectsHook=",
  "credential.helper=",
];

export function hardenedGitArgs(args: readonly string[]): string[] {
  return [...GIT_CONFIG.flatMap((c) => ["-c", c]), ...args];
}

// No system/global config: filter, diff and merge drivers defined on the
// host (git-lfs, textconv) cannot be triggered by attributes in the PR.
export function gitEnv(): NodeJS.ProcessEnv {
  return scrubbedEnv({
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    GIT_LFS_SKIP_SMUDGE: "1",
  });
}
