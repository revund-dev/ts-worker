# revund/workers/ts

Node.js service. The first-party TypeScript / JavaScript sidecar — implements the universal
`revund.worker.v1.Worker` contract. The bot dials it over gRPC; `Describe` reports
`languages = ["typescript", "javascript"]` and `capabilities = ["parse", "resolve_symbols",
"diagnostics"]`.

## Read first

See `/CLAUDE.md` for product context and data types.
See `/proto/worker/v1/worker.proto` for the wire contract every worker speaks.

## Stack

- **Runtime:** Node.js 20+
- **TypeScript analysis:** `ts-morph` — AST traversal, symbol resolution
- **gRPC server:** `@grpc/grpc-js` + `@grpc/proto-loader`
- **Proto source:** `../../proto/worker/v1/worker.proto` — the universal worker contract,
  shared with php and ruby sidecars. Pin against this file, not a per-language copy.

## What this service does

Four RPCs — three of them capabilities advertised in `Describe`:

**Describe + Health** — the bot calls Describe on first connect to learn name, version,
languages, and capabilities. Health is a standard liveness probe.

**Parse (required)** — walks the ts-morph AST and emits the universal `ParsedFile`
shape: imports, top-level decls, functions (with hash + canonical_hash + blocks),
and concern evidence (Presentation/State/Network/IO/Config/Business). The bot's
structural detectors consume the same shape across every language.

**ResolveSymbols (optional, "resolve_symbols")** — given a diff and a repo path, finds
the declarations of all external symbols referenced in the changed code but defined
elsewhere. Example: the diff calls `validateToken(user)` but `validateToken` is declared
in `src/auth/helpers.ts`. The resolver finds that declaration and returns it as a
`SymbolDecl` so the bot can include it in the ContextBundle.

**RunDiagnostics (optional, "diagnostics")** — runs `tsc --noEmit` on the repo and
returns structured diagnostics. These are pre-merge type errors that the AI can
explain and contextualize in its findings.

## Package structure

```
workers/ts/
├── src/
│   ├── server.ts            # gRPC server entrypoint (Describe/Health/Parse/Resolve/Diagnostics)
│   ├── parser.ts            # ts-morph → universal ParsedFile shape
│   ├── resolver.ts          # symbol resolution via ts-morph
│   ├── diagnostics.ts       # forks tsc-runner, filters diagnostics to changed files
│   ├── tsc-runner.ts        # child process: bundled TS compiler API, no repo code
│   └── utils/
│       ├── diff.ts          # extracts referenced identifiers from diff text
│       ├── project.ts       # ts-morph Project factory, caches per repo path
│       └── sandbox.ts       # scrubbed env + hardened git args for subprocesses
├── package.json
└── tsconfig.json
```

The proto contract lives at the workspace root (`/proto/worker/v1/worker.proto`) and is
loaded at server startup via a relative `../../../proto/...` walk from `src/` or `dist/`.
Override with `REVUND_WORKER_PROTO` for non-standard container layouts.

## Symbol resolution approach

1. Parse diff text to extract identifiers referenced but not declared in changed hunks
2. Load the repo's `tsconfig.json` via `ts-morph` Project
3. For each unresolved identifier, find its declaration node in the project
4. Return the declaration source text, file path, and line range

Cache the `ts-morph` Project instance per repo path — project initialization is expensive.
Invalidate cache when `tsconfig.json` mtime changes.

```typescript
interface SymbolDecl {
    name: string
    filePath: string
    startLine: number
    endLine: number
    text: string             // full declaration source text
}
```

## Diagnostics approach

**Never execute code from the reviewed repo** (REV-17, see `/docs/threat-model.md`).
No `<repo>/node_modules/.bin/tsc`, no `npx`, no tsc from PATH.

1. `diagnostics.ts` forks `tsc-runner.js` with a scrubbed env (`utils/sandbox.ts`) and
   cwd outside the repo; killed after 30s
2. The runner type-checks with the TypeScript bundled in ts-morph (our own dependency)
   via the compiler API — only `<repo>/tsconfig.json`, `plugins` stripped, emit and
   build info off, root files outside the repo dropped
3. Results come back over IPC; filter to files changed in the diff, cap at 200
4. Return structured `TscDiagnostic[]`

Every `git` call in `fetcher.ts` goes through `hardenedGitArgs` + `gitEnv`: hooks,
fsmonitor and system/global git config off, allow-listed env.

```typescript
interface TscDiagnostic {
    file: string
    line: number
    col: number
    code: string             // e.g. "TS2345"
    message: string
}
```

## gRPC server

Listens on `0.0.0.0:50051` by default, overridable via `TS_WORKER_PORT`.
Implements the five RPCs defined in `/proto/worker/v1/worker.proto`
(`revund.worker.v1.Worker` service).

On startup: verify Node version, then start server. tsc is never looked up on PATH.
First stdout line after a successful bind is `ready: <addr>` — when running as a
spawned sidecar, the parent process greps for that to know when to start sending
requests.

## Error handling

- If the tsc runner fails or times out, `RunDiagnostics` returns empty array — never error
- If a symbol cannot be resolved, skip it silently — partial resolution is valid
- If the ts-morph Project fails to load (bad tsconfig), return error so core can fall back
- Never crash the server on a single bad request — catch all errors per-request

## Environment variables

```
TS_WORKER_PORT          # gRPC port, default 50051
TS_WORKER_LOG           # debug | info | warn, default info
REVUND_WORKER_PROTO     # override path to worker.proto (container deployments)
```

## Performance notes

- ts-morph Project load: ~800ms cold, ~0ms warm — always cache per repo path
- tsc --noEmit: ~2–8s depending on repo size — run concurrently with other passes
- Symbol resolution: ~50ms per identifier once project is loaded
- Target: total ts-worker contribution to review latency under 10s