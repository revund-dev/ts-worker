// fetcher — clones the repo into a local cache directory when the
// worker is dispatched in self-fetch mode (RepoSource on the
// request). Returns the absolute path to the cached checkout so the
// rest of the worker (parser, resolver, diagnostics) can operate
// against it exactly as if the bot had cloned it.
//
// # Cache layout
//
//   $REVUND_WORKER_CACHE_DIR/<sha256(url@ref)>/
//
// Default cache dir is `/var/cache/revund-worker`. The hash key
// includes both URL and ref so two reviews targeting different
// commits of the same repo share nothing — keeps tenant blast-radius
// to one cache entry.
//
// # Token hygiene (security)
//
// The token is used at clone time only:
//
//   1. Compose the authenticated URL via x-access-token convention.
//      `https://x-access-token:<token>@host/path.git`.
//   2. Run `git clone --filter=blob:none --no-checkout <auth-url>
//      <dir>`. The blob-filter keeps the clone small; checkout
//      happens after the ref is fetched.
//   3. Immediately rewrite the remote URL to the un-authenticated
//      version: `git remote set-url origin <clean-url>`. After this
//      step, `cat .git/config` shows no token.
//   4. Fetch the requested ref and check it out.
//
// Errors and log messages NEVER include the URL with the embedded
// token; the sanitizer strips it before raising / logging.

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface RepoSource {
  url: string;
  ref: string;
  authToken: string;
  // Basic-auth username paired with authToken. Default
  // "x-access-token" (GitHub). GitLab → "oauth2",
  // Bitbucket → "x-token-auth".
  authUser?: string;
}

const DEFAULT_CACHE_DIR = "/var/cache/revund-worker";
const DEFAULT_IDLE_TTL_MS = 10 * 60 * 1000; // 10 min

// In-memory mtime registry. We touch the cache entry's mtime via
// the filesystem (utimes) on every reuse so external observers can
// see "what's hot," but the eviction sweep below uses this in-memory
// map first for cheaper checks. Falls back to fs.statSync.
const lastTouched = new Map<string, number>();

/**
 * Resolve the local checkout for `src`. Clones if cold, returns the
 * cached path if warm. Idempotent within the worker process.
 *
 * Errors thrown by this function never include the raw URL or token
 * — only the host + path. Callers that propagate these errors to
 * RPC responses can pass them through without further sanitization.
 */
export function fetchOrCache(src: RepoSource): string {
  if (!src.url) {
    throw new Error("fetcher: RepoSource.url is required");
  }
  if (!src.ref) {
    throw new Error("fetcher: RepoSource.ref is required");
  }

  const cacheDir = process.env.REVUND_WORKER_CACHE_DIR ?? DEFAULT_CACHE_DIR;
  mkdirSync(cacheDir, { recursive: true });

  const key = cacheKey(src.url, src.ref);
  const repoDir = join(cacheDir, key);

  if (existsSync(join(repoDir, ".git"))) {
    // Warm cache — touch and return.
    touch(repoDir);
    return repoDir;
  }

  // Cold clone. Use the authenticated URL once, strip immediately
  // after the clone succeeds.
  const cleanURL = src.url;
  const authURL = injectToken(cleanURL, src.authToken, src.authUser);
  mkdirSync(repoDir, { recursive: true });

  run("git", ["clone", "--filter=blob:none", "--no-checkout", authURL, repoDir]);

  // CRITICAL — strip the token before doing anything else.
  // From this point on, the on-disk state contains no token.
  run("git", ["-C", repoDir, "remote", "set-url", "origin", cleanURL]);

  // Make sure the requested ref is locally reachable. For commit
  // SHAs the initial clone usually didn't fetch the exact object
  // (filter=blob:none + clone-only-default-branch); explicit fetch
  // ensures the checkout below succeeds.
  run("git", ["-C", repoDir, "fetch", "origin", src.ref]);
  run("git", ["-C", repoDir, "checkout", src.ref]);

  touch(repoDir);

  // Lazy eviction: schedule a sweep so other cache entries that
  // haven't been touched in a while get cleaned up. setImmediate
  // keeps the request path snappy.
  setImmediate(() => evictIdle(cacheDir));

  return repoDir;
}

function cacheKey(url: string, ref: string): string {
  return createHash("sha256").update(`${url}@${ref}`).digest("hex").slice(0, 32);
}

function touch(dir: string): void {
  lastTouched.set(dir, Date.now());
}

function evictIdle(cacheDir: string): void {
  const ttl = Number(process.env.REVUND_WORKER_CACHE_TTL_SEC ?? 0) * 1000 || DEFAULT_IDLE_TTL_MS;
  const cutoff = Date.now() - ttl;

  let entries: string[];
  try {
    entries = require("node:fs").readdirSync(cacheDir);
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(cacheDir, e);
    const t = lastTouched.get(full) ?? (() => {
      try { return statSync(full).mtimeMs; } catch { return Date.now(); }
    })();
    if (t > cutoff) continue;
    try {
      require("node:fs").rmSync(full, { recursive: true, force: true });
      lastTouched.delete(full);
    } catch {
      // Best-effort. Stale entries that fail to remove just stick
      // around — they'll be retried on the next eviction sweep.
    }
  }
}

// injectToken composes the authenticated clone URL by inserting a
// basic-auth pair into the https URL. The username is supplied by
// the bot via RepoSource.authUser; when empty, defaults to
// "x-access-token" (GitHub's convention). Other platforms set it
// explicitly: GitLab → "oauth2", Bitbucket → "x-token-auth".
//
// When token is empty the URL passes through untouched, on the
// theory that the caller already embedded credentials upstream.
function injectToken(cloneURL: string, token: string, user?: string): string {
  if (!token) {
    return cloneURL;
  }
  const HTTPS = "https://";
  if (!cloneURL.startsWith(HTTPS)) {
    return cloneURL; // ssh:// or already-authenticated; pass through
  }
  const u = user && user !== "" ? user : "x-access-token";
  return HTTPS + u + ":" + token + "@" + cloneURL.slice(HTTPS.length);
}

// run executes git with the given args, captures stderr, and throws
// a sanitized error on failure. The thrown message NEVER contains
// the auth URL — only the args slice with the token argument elided.
function run(bin: string, args: string[]): void {
  let res: SpawnSyncReturns<Buffer>;
  try {
    res = spawnSync(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    throw new Error(`fetcher: ${bin} spawn failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.error) {
    throw new Error(`fetcher: ${bin} spawn errored: ${res.error.message}`);
  }
  if (res.status !== 0) {
    const stderr = res.stderr?.toString() ?? "";
    throw new Error(`fetcher: ${bin} ${redactArgs(args).join(" ")} exited ${res.status}: ${redact(stderr)}`);
  }
}

// redactArgs scrubs any arg that looks like an authenticated URL.
function redactArgs(args: string[]): string[] {
  return args.map((a) => (looksLikeAuthenticatedURL(a) ? redact(a) : a));
}

function looksLikeAuthenticatedURL(s: string): boolean {
  // Any URL containing user:password@host is suspect.
  return /^https?:\/\/[^/@]+:[^/@]+@/.test(s);
}

// redact replaces any occurrences of "://USER:PASS@HOST" with
// "://[redacted]@HOST". Used on stderr and arg lists.
function redact(s: string): string {
  return s.replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/g, "$1[redacted]@");
}
