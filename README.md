# @revund/ts-worker

The TypeScript / JavaScript AST sidecar for [Revund](https://revund.dev).
A gRPC server that implements `revund.worker.v1.Worker` — the universal
contract every Revund worker speaks. Built on `ts-morph` for AST traversal
and `tsc` for diagnostics.

## Install

```bash
npm install -g @revund/ts-worker
```

You'll also need the [`revund`](https://revund.dev/install) CLI itself. The
CLI discovers `revund-ts-worker` on `PATH` and spawns it on demand.

## Usage

The worker is normally launched by the Revund CLI. To run it standalone (for
debugging or to share a single instance across reviews):

```bash
revund-ts-worker                  # binds 0.0.0.0:50051
TS_WORKER_PORT=0 revund-ts-worker # OS-assigned port; prints "ready: 0.0.0.0:<port>" on stdout
```

Point the CLI at it via the `REVUND_WORKERS` env var (plain
`host:port` — the CLI calls `Describe` to learn the worker's
languages and capabilities):

```bash
REVUND_WORKERS=localhost:50051 revund review
```

## What it does

The worker advertises three capabilities via the `Describe` RPC:

| Capability | RPC | Purpose |
|---|---|---|
| `parse` | `Parse` | Returns the universal `ParsedFile` shape — imports, top-level decls, functions (with hash + canonical hash + blocks), and concern evidence (Presentation/State/Network/IO/Config/Business). |
| `resolve_symbols` | `ResolveSymbols` | Given a diff, finds declarations of external symbols referenced in the changed code. |
| `diagnostics` | `RunDiagnostics` | Runs `tsc --noEmit` against the repo and returns errors touching the changed files. |

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `TS_WORKER_PORT` | `50051` | Bind port. Use `0` for OS-assigned (recommended when the CLI spawns the worker). |
| `REVUND_WORKER_PROTO` | (auto-resolved) | Override path to `worker.proto`. Auto-resolution covers monorepo, npm-installed, and Docker layouts. |

## Contract

The wire contract is defined in
[`proto/worker/v1/worker.proto`](./proto/worker/v1/worker.proto), vendored
inside the package. The canonical source lives at
[`revund-dev/revund-workers/proto/worker/v1/worker.proto`](https://github.com/revund-dev/revund-workers/blob/main/proto/worker/v1/worker.proto).

## License

Apache-2.0
