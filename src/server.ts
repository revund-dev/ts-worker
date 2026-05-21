// ts-worker entrypoint. Loads the universal worker contract from
// ../../proto/worker/v1/worker.proto and implements the
// `revund.worker.v1.Worker` service for TypeScript / JavaScript.
//
// # Service surface
//
// - Describe        → self-identifies (name, version, languages,
//                     capabilities). Called by the bot at startup
//                     to learn what this worker can do.
// - Health          → standard liveness probe.
// - Parse           → REQUIRED. Walks ts-morph and returns the
//                     universal ParsedFile shape.
// - ResolveSymbols  → OPTIONAL (capability "resolve_symbols"). Pulls
//                     declarations of identifiers referenced in a
//                     diff but defined elsewhere.
// - RunDiagnostics  → OPTIONAL (capability "diagnostics"). Runs
//                     `tsc --noEmit` and returns errors touching the
//                     changed files.
//
// # Readiness signal
//
// First stdout line after a successful bind is `ready: <addr>`. The
// parent process (core, in spawned-sidecar mode) greps for that and
// proceeds. In standalone mode the message is purely informational.

import { resolve } from "node:path";
import { existsSync } from "node:fs";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

import { resolveSymbols } from "./resolver";
import { runDiagnostics } from "./diagnostics";
import { parseFiles } from "./parser";
import { fetchOrCache, type RepoSource } from "./fetcher";

const VERSION = "0.1.0";
const NAME = "ts-worker";
const LANGUAGES = ["typescript", "javascript"];
const CAPABILITIES = ["parse", "resolve_symbols", "diagnostics", "self_fetch"];
const DEFAULT_PORT = 50051;

// ─────────────────────────────────────────────────────────
// proto message shapes (snake_case mirrors the .proto so the
// grpc binding doesn't have to translate)
// ─────────────────────────────────────────────────────────

interface DescribeRequest {}
interface DescribeResponse {
  name: string;
  version: string;
  languages: string[];
  capabilities: string[];
}

interface HealthRequest {}
interface HealthResponse {
  version: string;
}

// proto3 + proto-loader maps `RepoSource repo_source = N` onto a
// nested object with snake_case property names. When the bot leaves
// the field unset, the value is null/undefined.
interface RepoSourceMsg {
  url: string;
  ref: string;
  auth_token: string;
  auth_user: string;
}

interface ParseRequest {
  repo_path: string;
  files: string[];
  repo_source?: RepoSourceMsg;
}
interface ParseResponse {
  files: unknown[]; // parser.ts already returns the proto shape verbatim
}

interface ResolveRequest {
  repo_path: string;
  diff: string;
  changed_files: string[];
  repo_source?: RepoSourceMsg;
}
interface SymbolDecl {
  name: string;
  file_path: string;
  start_line: number;
  end_line: number;
  text: string;
}
interface ResolveResponse {
  symbols: SymbolDecl[];
}

interface DiagnosticsRequest {
  repo_path: string;
  filter_files: string[];
  repo_source?: RepoSourceMsg;
}
interface Diagnostic {
  file: string;
  line: number;
  col: number;
  code: string;
  message: string;
}
interface DiagnosticsResponse {
  diagnostics: Diagnostic[];
}

type Cb<R> = grpc.sendUnaryData<R>;

// AUTH_HEADER + AUTH_SECRET_ENV mirror the Go-side constants in
// core/pkg/worker/auth.go. The bot stamps the header on every
// outbound RPC; the worker rejects requests without a matching
// value when the env var is configured. Empty / unset =
// "accept everything" — appropriate for CLI / local-dev where
// the worker is a localhost subprocess.
const AUTH_HEADER = "x-revund-worker-token";
const AUTH_SECRET_ENV = "REVUND_WORKER_SECRET";

function configuredSecret(): string {
  return process.env[AUTH_SECRET_ENV] ?? "";
}

function rpcError(err: unknown, name: string): grpc.ServerErrorResponse {
  return {
    code: grpc.status.INTERNAL,
    message: err instanceof Error ? err.message : String(err),
    name,
  };
}

// authorized checks the incoming RPC's metadata for the bearer
// header when a secret is configured. Returns null on success,
// or an UNAUTHENTICATED gRPC error to send back to the caller.
//
// The caller wraps every RPC handler with this — kept as a per-
// handler check rather than a server-wide interceptor because
// @grpc/grpc-js doesn't expose unary-server interceptors at the
// same level as the Go API, and one extra line per handler is
// cheaper than a wrapper layer.
function authorized(call: grpc.ServerUnaryCall<unknown, unknown>): grpc.ServerErrorResponse | null {
  const expected = configuredSecret();
  if (expected === "") {
    return null; // no enforcement configured
  }
  const md = call.metadata.get(AUTH_HEADER);
  const got = Array.isArray(md) && md.length > 0 ? String(md[0]) : "";
  if (got !== expected) {
    return {
      code: grpc.status.UNAUTHENTICATED,
      message: "missing or invalid x-revund-worker-token",
      name: "Unauthenticated",
    };
  }
  return null;
}

// resolveRepoPath unifies the two dispatch modes the bot uses:
//
//   - Shared-FS path mode: the bot cloned the repo to `repo_path`
//     and both sides see the same filesystem. Return repo_path
//     verbatim.
//
//   - Self-fetch mode: the bot sent a RepoSource (url + ref +
//     auth_token). Hand it to the fetcher, which clones into a
//     local cache directory and returns the absolute checkout path.
//
// Either way, the rest of the handler operates on an absolute
// local path — the parser/resolver/diagnostics code is mode-
// agnostic.
function resolveRepoPath(repoPath: string, src: RepoSourceMsg | undefined): string {
  if (src && src.url) {
    const rs: RepoSource = {
      url: src.url,
      ref: src.ref,
      authToken: src.auth_token ?? "",
      authUser: src.auth_user ?? "",
    };
    return fetchOrCache(rs);
  }
  return repoPath;
}

function loadProto(): grpc.GrpcObject {
  // Resolve the proto file relative to this module so the worker can
  // run from anywhere — three deployment shapes to support:
  //
  //   1. Monorepo dev / dist:
  //        /workers/ts/{src,dist}/server.js  →  ../../../proto/worker/v1/worker.proto
  //
  //   2. npm-installed package (the publish layout — proto is vendored
  //      inside the package as a sibling of dist/):
  //        node_modules/@revund/ts-worker/dist/server.js
  //          → ../proto/worker/v1/worker.proto
  //
  //   3. Docker (Dockerfile copies /proto to /app/proto):
  //        /app/workers/ts/dist/server.js  →  ../../../proto/worker/v1/worker.proto
  //
  // REVUND_WORKER_PROTO env var wins over auto-resolution for operators
  // who land the proto in a non-standard location.
  const candidates = [
    // Container override — checked first so deploy-time wiring beats heuristics.
    process.env.REVUND_WORKER_PROTO ?? "",
    // Monorepo / docker layout (proto at workspace root).
    resolve(__dirname, "..", "..", "..", "proto", "worker", "v1", "worker.proto"),
    // npm-installed layout (proto vendored inside the package).
    resolve(__dirname, "..", "proto", "worker", "v1", "worker.proto"),
    // Back-compat alias from the pre-rename era.
    process.env.TS_WORKER_PROTO ?? "",
  ];
  const protoPath = candidates.find((p) => p && existsSync(p));
  if (!protoPath) {
    throw new Error(
      `worker.proto not found. Looked at: ${candidates.filter(Boolean).join(", ")}. ` +
        "Set REVUND_WORKER_PROTO to override.",
    );
  }
  const def = protoLoader.loadSync(protoPath, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  return grpc.loadPackageDefinition(def) as grpc.GrpcObject;
}

function getServiceCtor(proto: grpc.GrpcObject): grpc.ServiceClientConstructor {
  // proto.revund.worker.v1.Worker — descend the namespace tree.
  const ns = proto as {
    revund: { worker: { v1: { Worker: grpc.ServiceClientConstructor } } };
  };
  return ns.revund.worker.v1.Worker;
}

function main(): void {
  const port = Number(process.env.TS_WORKER_PORT ?? DEFAULT_PORT);
  const addr = `0.0.0.0:${port}`;

  const proto = loadProto();
  const Worker = getServiceCtor(proto);

  const server = new grpc.Server();
  server.addService(Worker.service, {
    Describe: (call: grpc.ServerUnaryCall<DescribeRequest, DescribeResponse>, cb: Cb<DescribeResponse>) => {
      const denied = authorized(call);
      if (denied) { cb(denied); return; }
      cb(null, {
        name: NAME,
        version: VERSION,
        languages: LANGUAGES,
        capabilities: CAPABILITIES,
      });
    },
    Health: (call: grpc.ServerUnaryCall<HealthRequest, HealthResponse>, cb: Cb<HealthResponse>) => {
      const denied = authorized(call);
      if (denied) { cb(denied); return; }
      cb(null, { version: VERSION });
    },
    Parse: (call: grpc.ServerUnaryCall<ParseRequest, ParseResponse>, cb: Cb<ParseResponse>) => {
      const denied = authorized(call);
      if (denied) { cb(denied); return; }
      try {
        const repoPath = resolveRepoPath(call.request.repo_path, call.request.repo_source);
        const files = parseFiles({ repoPath, files: call.request.files });
        // parser.ts already produces objects whose field names match
        // the proto exactly (path, language, imports, decls, functions,
        // concerns, parse_error). Pass through verbatim.
        cb(null, { files });
      } catch (err) {
        cb(rpcError(err, "ParseError"));
      }
    },
    ResolveSymbols: async (
      call: grpc.ServerUnaryCall<ResolveRequest, ResolveResponse>,
      cb: Cb<ResolveResponse>,
    ) => {
      const denied = authorized(call);
      if (denied) { cb(denied); return; }
      try {
        const repoPath = resolveRepoPath(call.request.repo_path, call.request.repo_source);
        const symbols = await resolveSymbols({
          repoPath,
          diff: call.request.diff,
          changedFiles: call.request.changed_files,
        });
        cb(null, {
          symbols: symbols.map((s) => ({
            name: s.name,
            file_path: s.filePath,
            start_line: s.startLine,
            end_line: s.endLine,
            text: s.text,
          })),
        });
      } catch (err) {
        cb(rpcError(err, "ResolveError"));
      }
    },
    RunDiagnostics: async (
      call: grpc.ServerUnaryCall<DiagnosticsRequest, DiagnosticsResponse>,
      cb: Cb<DiagnosticsResponse>,
    ) => {
      const denied = authorized(call);
      if (denied) { cb(denied); return; }
      try {
        const repoPath = resolveRepoPath(call.request.repo_path, call.request.repo_source);
        const diagnostics = await runDiagnostics({
          repoPath,
          filterFiles: call.request.filter_files,
        });
        cb(null, {
          diagnostics: diagnostics.map((d) => ({
            file: d.file,
            line: d.line,
            col: d.col,
            code: d.code,
            message: d.message,
          })),
        });
      } catch (err) {
        cb(rpcError(err, "DiagnosticsError"));
      }
    },
  });

  server.bindAsync(addr, grpc.ServerCredentials.createInsecure(), (err, boundPort) => {
    if (err) {
      // eslint-disable-next-line no-console
      console.error(`bind failed: ${err.message}`);
      process.exit(1);
    }
    // eslint-disable-next-line no-console
    console.log(`ready: 0.0.0.0:${boundPort}`);
  });

  // Clean shutdown on parent termination — core sends SIGTERM during cleanup.
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      server.tryShutdown(() => process.exit(0));
    });
  }
}

main();
