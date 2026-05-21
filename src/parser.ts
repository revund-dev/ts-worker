// Parse RPC implementation. Walks the TypeScript AST via ts-morph and
// produces a compact AST view (imports + top-level decls + functions)
// for the structural detectors on the Go side.
//
// # Why ts-morph (and not a hand-rolled visitor on the bare ts API)
//
// ts-morph already gives us:
//   - Node.getKindName() for stable per-node identification
//   - SourceFile traversal helpers (getImportDeclarations,
//     getFunctions, getClasses, getVariableStatements, etc.)
//   - Line/column position helpers that don't require carrying a
//     SourceFile reference into every helper
//
// Hand-rolling on the raw `typescript` package would be ~3x more code
// for no improvement in fidelity. ts-morph is already a dependency
// (resolver.ts uses it for the existing ResolveSymbols RPC) so we
// pay zero new bundle cost.
//
// # Component / hook classification
//
// We classify a top-level function or variable as a React component
// when ALL of:
//   - The exported name starts with an uppercase letter (React's
//     convention; a non-uppercase function would not be usable as JSX)
//   - The body contains JSX (any JsxElement, JsxSelfClosingElement,
//     or JsxFragment node in the descendant tree)
//
// A function is a hook when its exported name matches `^use[A-Z]`.
// We don't require it to call other hooks — the convention is the
// signal we trust, and a custom hook that happens not to call other
// hooks today is still a hook by intent.
//
// Both classifications happen at the parser layer (not in the
// detector) so the structural detectors stay language-agnostic. A
// component is a component whether it was declared as a function,
// arrow, or class.

import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  Node,
  Project,
  SourceFile,
  SyntaxKind,
  ts,
  type FunctionDeclaration,
  type VariableStatement,
  type ClassDeclaration,
} from "ts-morph";

import { getProject } from "./utils/project";

// ParsedFile mirrors the proto ParsedFile message. Keep field names
// in sync with the proto's snake_case so the gRPC binding doesn't
// have to translate.
export interface ParsedFile {
  path: string;
  language: string;
  imports: ImportRef[];
  decls: DeclRef[];
  functions: FunctionRef[];
  concerns: ConcernEvidenceRef[];
  parse_error: string;
}

// ConcernEvidenceRef mirrors the proto message. Category is one
// of the canonical concern names; the Go side demuxes by string
// into a typed ConcernSet. New categories are added by extending
// the parser; older Go clients silently drop unknown values.
export interface ConcernEvidenceRef {
  category: ConcernCategory;
  line: number;
  symbol: string;
  note: string;
}

type ConcernCategory =
  | "presentation"
  | "state"
  | "transport"
  | "network"
  | "dataaccess"
  | "io"
  | "config"
  | "business";

export interface ImportRef {
  path: string;
  alias: string;
  line: number;
}

export interface DeclRef {
  name: string;
  kind: DeclKind;
  line: number;
  end_line: number;
  exported: boolean;
}

export interface FunctionRef {
  name: string;
  start_line: number;
  end_line: number;
  complexity: number;
  is_method: boolean;
  is_exported: boolean;
  hash: string;
  canonical_hash: string;
  blocks: BlockRef[];
}

export interface BlockRef {
  kind: string;
  start_line: number;
  end_line: number;
  hash: string;
  canonical_hash: string;
}

// DeclKind values mirror the Go lang.DeclKind constants. Adding a
// new kind requires adding the matching constant on the Go side too.
type DeclKind =
  | "function"
  | "method"
  | "type"
  | "interface"
  | "const"
  | "var"
  | "class"
  | "component"
  | "hook";

export interface ParseArgs {
  repoPath: string;
  files: string[]; // repo-relative paths
}

// parseFiles is the RPC entry. The project cache (getProject) keeps
// the ts-morph Project warm across requests, so the second call
// against the same repo skips the ~800ms cold-load cost.
export function parseFiles(args: ParseArgs): ParsedFile[] {
  const project = getProject(args.repoPath);
  return args.files.map((rel) => parseOne(project, args.repoPath, rel));
}

function parseOne(project: Project, repoPath: string, rel: string): ParsedFile {
  const abs = join(repoPath, rel);
  let sf = project.getSourceFile(abs);
  if (!sf) {
    sf = project.addSourceFileAtPathIfExists(abs);
  }
  if (!sf) {
    return emptyFile(rel, "file not found");
  }

  try {
    const imports = collectImports(sf);
    return {
      path: rel,
      language: languageOf(rel),
      imports,
      decls: collectDecls(sf),
      functions: collectFunctions(sf),
      concerns: collectConcerns(sf, imports),
      parse_error: "",
    };
  } catch (err) {
    // A single bad file should not sink the whole batch. Return an
    // empty ParsedFile carrying the error string; the Go side will
    // see it via parse_error and skip the file.
    return emptyFile(rel, err instanceof Error ? err.message : String(err));
  }
}

function emptyFile(path: string, err: string): ParsedFile {
  return {
    path,
    language: languageOf(path),
    imports: [],
    decls: [],
    functions: [],
    concerns: [],
    parse_error: err,
  };
}

function languageOf(rel: string): string {
  if (/\.(tsx?|mts|cts)$/i.test(rel)) return "typescript";
  if (/\.(jsx?|mjs|cjs)$/i.test(rel)) return "javascript";
  return "other";
}

// --- collectors ---

function collectImports(sf: SourceFile): ImportRef[] {
  const out: ImportRef[] = [];
  for (const imp of sf.getImportDeclarations()) {
    const path = imp.getModuleSpecifierValue();
    const line = imp.getStartLineNumber();

    // Default import: `import Foo from "x"` → alias = "Foo"
    const def = imp.getDefaultImport()?.getText() ?? "";
    if (def) out.push({ path, alias: def, line });

    // Namespace import: `import * as Foo from "x"` → alias = "Foo"
    const ns = imp.getNamespaceImport()?.getText() ?? "";
    if (ns) out.push({ path, alias: ns, line });

    // Named imports: `import { Foo, Bar as Baz } from "x"` →
    // one entry per name, alias = the binding name (renamed or not).
    for (const named of imp.getNamedImports()) {
      out.push({
        path,
        alias: named.getAliasNode()?.getText() ?? named.getName(),
        line,
      });
    }

    // Bare import: `import "x"` (no bindings). Still record so
    // detectors that scan import paths see it.
    if (!def && !ns && imp.getNamedImports().length === 0) {
      out.push({ path, alias: "", line });
    }
  }
  return out;
}

function collectDecls(sf: SourceFile): DeclRef[] {
  const out: DeclRef[] = [];

  // Function declarations: `function foo() {...}` and `export function foo() {...}`.
  for (const fn of sf.getFunctions()) {
    const name = fn.getName() ?? "";
    if (!name) continue;
    out.push({
      name,
      kind: classifyFunctionAsComponentOrHook(fn, name),
      line: fn.getStartLineNumber(),
      end_line: fn.getEndLineNumber(),
      exported: fn.isExported() || fn.isDefaultExport(),
    });
  }

  // Variable statements: `const Foo = () => <div/>`, `export const useFoo = () => {...}`, etc.
  // ts-morph models these as VariableStatement → VariableDeclaration.
  for (const vstmt of sf.getVariableStatements()) {
    const exported = vstmt.isExported() || vstmt.isDefaultExport();
    for (const decl of vstmt.getDeclarations()) {
      const name = decl.getName();
      if (!name) continue;
      out.push({
        name,
        kind: classifyVariableDeclKind(decl.getInitializer(), name, vstmt),
        line: decl.getStartLineNumber(),
        end_line: decl.getEndLineNumber(),
        exported,
      });
    }
  }

  // Class declarations.
  for (const cls of sf.getClasses()) {
    const name = cls.getName() ?? "";
    if (!name) continue;
    out.push({
      name,
      kind: classifyClass(cls, name),
      line: cls.getStartLineNumber(),
      end_line: cls.getEndLineNumber(),
      exported: cls.isExported() || cls.isDefaultExport(),
    });
  }

  // Interface declarations.
  for (const iface of sf.getInterfaces()) {
    out.push({
      name: iface.getName(),
      kind: "interface",
      line: iface.getStartLineNumber(),
      end_line: iface.getEndLineNumber(),
      exported: iface.isExported() || iface.isDefaultExport(),
    });
  }

  // Type alias declarations.
  for (const ta of sf.getTypeAliases()) {
    out.push({
      name: ta.getName(),
      kind: "type",
      line: ta.getStartLineNumber(),
      end_line: ta.getEndLineNumber(),
      exported: ta.isExported() || ta.isDefaultExport(),
    });
  }

  // Default-export expression: `export default function() {...}` or
  // `export default Foo` where Foo was declared above. The named
  // case is already captured by the function/variable loops; the
  // anonymous case we record as an unnamed component if it returns
  // JSX. For now we only catch named defaults — anonymous default
  // exports are rare and add complexity for marginal value.

  return out;
}

function collectFunctions(sf: SourceFile): FunctionRef[] {
  const out: FunctionRef[] = [];

  for (const fn of sf.getFunctions()) {
    const name = fn.getName() ?? "<anonymous>";
    out.push({
      name,
      start_line: fn.getStartLineNumber(),
      end_line: fn.getEndLineNumber(),
      complexity: cyclomatic(fn),
      is_method: false,
      is_exported: fn.isExported() || fn.isDefaultExport(),
      hash: hashFunctionBody(fn),
      canonical_hash: canonicalHashBody(fn),
      blocks: extractBlocks(fn),
    });
  }

  // Methods (inside classes).
  for (const cls of sf.getClasses()) {
    for (const m of cls.getMethods()) {
      out.push({
        name: m.getName(),
        start_line: m.getStartLineNumber(),
        end_line: m.getEndLineNumber(),
        complexity: cyclomatic(m),
        is_method: true,
        is_exported: cls.isExported() || cls.isDefaultExport(),
        hash: hashFunctionBody(m),
        canonical_hash: canonicalHashBody(m),
        blocks: extractBlocks(m),
      });
    }
  }

  return out;
}

// canonicalHashBody mirrors the Go-side canonicalHashGoBody.
// Maps every TypeScript AST node onto the shared canonical
// token vocabulary so functions written in different
// languages can cluster on shared shapes.
//
// See ../core/pkg/structural/lang/canonical.go for the
// canonical token names; keep the two mappings in sync.
function canonicalHashBody(fn: Node): string {
  const parts: string[] = [];
  let nodes = 0;
  fn.forEachDescendant((child) => {
    nodes++;
    parts.push(tsNodeToCanonical(child));
    return;
  });
  if (nodes <= 2) {
    return "";
  }
  return createHash("sha1").update(parts.join(";")).digest("hex").slice(0, 16);
}

// tsNodeToCanonical maps one TypeScript AST node onto the
// canonical token vocabulary. Unknown kinds fall through to
// "NODE" so a kind we haven't classified doesn't accidentally
// collide with another language's token of the same string.
function tsNodeToCanonical(node: Node): string {
  const k = node.getKind();
  switch (k) {
    case SyntaxKind.IfStatement:
      return "IF";
    case SyntaxKind.ForStatement:
    case SyntaxKind.ForOfStatement:
    case SyntaxKind.ForInStatement:
    case SyntaxKind.WhileStatement:
    case SyntaxKind.DoStatement:
      return "FOR";
    case SyntaxKind.ReturnStatement:
      return "RETURN";
    case SyntaxKind.Block:
      return "BLOCK";
    case SyntaxKind.SwitchStatement:
      return "SWITCH";
    case SyntaxKind.BreakStatement:
      return "BREAK";
    case SyntaxKind.ContinueStatement:
      return "CONTINUE";
    case SyntaxKind.TryStatement:
      return "TRY";
    case SyntaxKind.ThrowStatement:
      return "THROW";
    case SyntaxKind.CallExpression:
      return "CALL";
    case SyntaxKind.NewExpression:
      return "NEW";
    case SyntaxKind.PropertyAccessExpression:
      return "MEMBER";
    case SyntaxKind.ElementAccessExpression:
      return "INDEX";
    case SyntaxKind.Identifier:
      return "ID";
    case SyntaxKind.StringLiteral:
    case SyntaxKind.NoSubstitutionTemplateLiteral:
      return "LIT:STR";
    case SyntaxKind.NumericLiteral:
      return "LIT:NUM";
    case SyntaxKind.TrueKeyword:
    case SyntaxKind.FalseKeyword:
      return "LIT:BOOL";
    case SyntaxKind.NullKeyword:
    case SyntaxKind.UndefinedKeyword:
      return "LIT:NIL";
    case SyntaxKind.BinaryExpression: {
      const op = node
        .asKindOrThrow(SyntaxKind.BinaryExpression)
        .getOperatorToken()
        .getText();
      // Treat `=` (assignment) and compound assignments as
      // ASSIGN at the canonical level; preserve the operator
      // for non-assignment binaries.
      if (op === "=") return "ASSIGN";
      return "BIN:" + op;
    }
    case SyntaxKind.PrefixUnaryExpression: {
      const op = node
        .asKindOrThrow(SyntaxKind.PrefixUnaryExpression)
        .getOperatorToken();
      return "UN:" + op;
    }
    case SyntaxKind.PostfixUnaryExpression: {
      const tok = node
        .asKindOrThrow(SyntaxKind.PostfixUnaryExpression)
        .getOperatorToken();
      if (tok === SyntaxKind.PlusPlusToken) return "INC";
      if (tok === SyntaxKind.MinusMinusToken) return "DEC";
      return "NODE";
    }
    default:
      return "NODE";
  }
}

// extractBlocks walks the function body and produces one
// BlockRef per nested if/else/for/case body big enough to
// be interesting. Mirrors extractGoBlocks on the Go side;
// detectors that cluster blocks consume both uniformly via
// lang.FunctionBlock.
function extractBlocks(fn: Node): BlockRef[] {
  const out: BlockRef[] = [];
  const MIN_BLOCK_STMTS = 3;

  const addBlock = (block: Node, kind: string) => {
    // Count direct child statements; trivial bodies skip.
    const stmts = block.forEachChildAsArray().filter((c) => {
      // Skip the surrounding braces; ts-morph returns child
      // nodes including punctuation in some shapes.
      return c.getKind() !== SyntaxKind.OpenBraceToken && c.getKind() !== SyntaxKind.CloseBraceToken;
    });
    if (stmts.length < MIN_BLOCK_STMTS) return;
    const h = hashFunctionBody(block);
    const ch = canonicalHashBody(block);
    if (!h && !ch) return;
    out.push({
      kind,
      start_line: block.getStartLineNumber(),
      end_line: block.getEndLineNumber(),
      hash: h,
      canonical_hash: ch,
    });
  };

  fn.forEachDescendant((node) => {
    const k = node.getKind();
    switch (k) {
      case SyntaxKind.IfStatement: {
        const ifs = node.asKindOrThrow(SyntaxKind.IfStatement);
        const then = ifs.getThenStatement();
        if (then.isKind(SyntaxKind.Block)) addBlock(then, "if");
        const els = ifs.getElseStatement();
        if (els && els.isKind(SyntaxKind.Block)) addBlock(els, "else");
        break;
      }
      case SyntaxKind.ForStatement:
      case SyntaxKind.ForOfStatement:
      case SyntaxKind.ForInStatement:
      case SyntaxKind.WhileStatement:
      case SyntaxKind.DoStatement: {
        // ts-morph: each iteration statement has a `getStatement()`.
        const iter = node as unknown as { getStatement?: () => Node };
        const body = iter.getStatement?.();
        if (body && body.isKind(SyntaxKind.Block)) addBlock(body, "for");
        break;
      }
      case SyntaxKind.CaseClause:
      case SyntaxKind.DefaultClause: {
        // CaseClause has getStatements(); we wrap the statement
        // list in a synthetic block-like for hashing. Instead
        // of synthesizing, we feed each statement individually
        // — close enough for the canonical hash, slightly less
        // precise for the language-specific hash, acceptable.
        const cc = node;
        addBlock(cc, "case");
        break;
      }
      case SyntaxKind.TryStatement: {
        const ts = node.asKindOrThrow(SyntaxKind.TryStatement);
        addBlock(ts.getTryBlock(), "try");
        const cc = ts.getCatchClause();
        if (cc) addBlock(cc.getBlock(), "catch");
        const fb = ts.getFinallyBlock();
        if (fb) addBlock(fb, "finally");
        break;
      }
    }
  });
  return out;
}

// hashFunctionBody returns a canonical fingerprint of the
// function body's AST shape — the TypeScript counterpart to
// the Go-side hashGoFunctionBody. Two functions with the
// same hash share structure modulo identifier names and
// literal values; that's the DRY-detector signal.
//
// Hashing scheme:
//   - Keep node kinds (SyntaxKind.IfStatement, .ReturnStatement,
//     .BinaryExpression, …) so structure is preserved.
//   - Keep operator-bearing nodes' operator kind (the
//     PostfixUnaryOperator on `i++` etc. is implicit in the
//     node's kind text), keep BinaryExpression's operator
//     token kind so `a + b` and `a - b` hash differently.
//   - Skip identifier names (Identifier node text is the
//     name; we write a fixed "ID" instead).
//   - Skip literal values but keep the literal kind:
//     `return 42` and `return 0` collide; `return 42` and
//     `return "hi"` do not.
//
// Returns "" for bodies with ≤2 nodes — trivial getters /
// one-line wrappers add no signal even when identical, so
// we short-circuit.
function hashFunctionBody(fn: Node): string {
  const parts: string[] = [];
  let nodes = 0;
  fn.forEachDescendant((child) => {
    nodes++;
    const k = child.getKind();
    switch (k) {
      case SyntaxKind.Identifier:
        // Drop the name; record the position.
        parts.push("ID");
        break;
      case SyntaxKind.StringLiteral:
      case SyntaxKind.NoSubstitutionTemplateLiteral:
        parts.push("L:STR");
        break;
      case SyntaxKind.NumericLiteral:
        parts.push("L:NUM");
        break;
      case SyntaxKind.TrueKeyword:
      case SyntaxKind.FalseKeyword:
        parts.push("L:BOOL");
        break;
      case SyntaxKind.NullKeyword:
      case SyntaxKind.UndefinedKeyword:
        parts.push("L:NIL");
        break;
      case SyntaxKind.BinaryExpression: {
        // Preserve operator so `+` and `-` produce different
        // hashes — operators carry the function's intent.
        const op = child
          .asKindOrThrow(SyntaxKind.BinaryExpression)
          .getOperatorToken()
          .getKindName();
        parts.push("BIN:" + op);
        break;
      }
      default:
        parts.push(child.getKindName());
    }
  });
  if (nodes <= 2) {
    return "";
  }
  return createHash("sha1").update(parts.join(";")).digest("hex").slice(0, 16);
}

// --- concern extraction ---
//
// One AST walk classifies every node into the appropriate
// concern bucket. The classifier covers:
//
//   - JSX → Presentation (per-element evidence)
//   - useState / useReducer / useContext / useRef / useMemo
//     / useCallback / useSelector / useDispatch / useStore
//     → State
//   - fetch / axios.* / ky.* / got.* / useQuery / useMutation
//     / useSWR / useSWRInfinite → Network
//   - localStorage.* / sessionStorage.* → IO
//   - process.env.* / import.meta.env.* → Config
//   - Functions whose complexity ≥8 → Business
//
// Plus import-path-based signals (axios import, prisma import,
// fs import, etc.) so a file that imports a network library
// counts even when the call sites use bindings the regex
// patterns can't resolve (e.g., `const api = axios.create()`
// followed by `api.get()`).
//
// Why a single walk: forEachDescendant is the expensive part.
// One walk produces the full set; consolidating the matchers
// here keeps the cost predictable per file.

function collectConcerns(sf: SourceFile, imports: ImportRef[]): ConcernEvidenceRef[] {
  const out: ConcernEvidenceRef[] = [];

  // Tier 1: imports establish coarse signals. A file that
  // imports axios is doing Network even if the call sites are
  // hard to pattern-match (e.g., wrapped in a thin client).
  for (const imp of imports) {
    const path = imp.path;
    if (isNetworkPackage(path)) {
      out.push({ category: "network", line: imp.line, symbol: path, note: "import" });
    }
    if (isDataAccessPackage(path)) {
      out.push({ category: "dataaccess", line: imp.line, symbol: path, note: "import" });
    }
    if (isIOPackage(path)) {
      out.push({ category: "io", line: imp.line, symbol: path, note: "import" });
    }
    if (isTransportPackage(path)) {
      out.push({ category: "transport", line: imp.line, symbol: path, note: "import" });
    }
  }

  // Tier 2: per-node classification. Single descendant walk.
  sf.forEachDescendant((node) => {
    const k = node.getKind();

    // Presentation — every JSX node is one signal. We don't
    // dedupe by line because two <div/> on the same line are
    // two signals; the volume threshold filters cleanly.
    if (
      k === SyntaxKind.JsxElement ||
      k === SyntaxKind.JsxSelfClosingElement ||
      k === SyntaxKind.JsxFragment
    ) {
      out.push({ category: "presentation", line: node.getStartLineNumber(), symbol: "JSX", note: "" });
      return;
    }

    // State / Network / IO via call patterns. We match the
    // EXPRESSION text (not just the function name) so
    // `axios.get` and `useQuery` are both catchable in one
    // pass.
    if (k === SyntaxKind.CallExpression) {
      const call = node.asKindOrThrow(SyntaxKind.CallExpression);
      const exprText = call.getExpression().getText();
      const line = call.getStartLineNumber();
      classifyCallExpression(exprText, line, out);
      return;
    }

    // Config — process.env.X and import.meta.env.X reads. We
    // anchor on the OUTER PropertyAccessExpression
    // (`process.env.DATABASE_URL`) and skip the inner
    // (`process.env`) by requiring a trailing-dot prefix.
    if (k === SyntaxKind.PropertyAccessExpression) {
      const text = node.getText();
      if (text.startsWith("process.env.") || text.startsWith("import.meta.env.")) {
        out.push({
          category: "config",
          line: node.getStartLineNumber(),
          symbol: trim(text, 60),
          note: "env read",
        });
      }
      return;
    }
  });

  // Business — high-complexity functions. Reuses the cyclomatic
  // helper already collected above; we ask sf for its function-
  // like descendants and check complexity against the threshold.
  const BUSINESS_COMPLEXITY = 8;
  for (const fn of sf.getFunctions()) {
    if (cyclomatic(fn) >= BUSINESS_COMPLEXITY) {
      out.push({
        category: "business",
        line: fn.getStartLineNumber(),
        symbol: fn.getName() ?? "<anonymous>",
        note: "complex function",
      });
    }
  }
  for (const cls of sf.getClasses()) {
    for (const m of cls.getMethods()) {
      if (cyclomatic(m) >= BUSINESS_COMPLEXITY) {
        out.push({
          category: "business",
          line: m.getStartLineNumber(),
          symbol: `${cls.getName() ?? "?"}.${m.getName()}`,
          note: "complex method",
        });
      }
    }
  }

  return out;
}

// classifyCallExpression looks at the call's expression text
// and routes to the matching concern category. Pure-string
// dispatch: ts-morph already gave us the AST node, but the
// expression text is the most stable identifier we can use
// without depending on type resolution (which would require
// the full ts-morph TypeChecker and bog down per-file parse
// time).
function classifyCallExpression(exprText: string, line: number, out: ConcernEvidenceRef[]): void {
  // React state hooks — direct calls. Custom hooks named
  // useFoo are handled by the decl classifier, not here.
  if (
    exprText === "useState" ||
    exprText === "useReducer" ||
    exprText === "useContext" ||
    exprText === "useRef" ||
    exprText === "useMemo" ||
    exprText === "useCallback" ||
    exprText === "React.useState" ||
    exprText === "React.useReducer" ||
    exprText === "React.useContext" ||
    exprText === "React.useRef"
  ) {
    out.push({ category: "state", line, symbol: exprText, note: "" });
    return;
  }
  // External store hooks
  if (
    exprText === "useSelector" ||
    exprText === "useDispatch" ||
    exprText === "useStore" ||
    exprText === "useAtom" ||
    exprText === "useAtomValue" ||
    exprText === "useSetAtom"
  ) {
    out.push({ category: "state", line, symbol: exprText, note: "store hook" });
    return;
  }

  // Network — global fetch and method calls on common HTTP
  // libraries (axios, ky, got).
  if (exprText === "fetch" || exprText === "window.fetch") {
    out.push({ category: "network", line, symbol: "fetch", note: "" });
    return;
  }
  if (/^(axios|ky|got)\.(get|post|put|delete|patch|head|options)$/i.test(exprText)) {
    out.push({ category: "network", line, symbol: exprText, note: "" });
    return;
  }
  if (
    exprText === "useQuery" ||
    exprText === "useMutation" ||
    exprText === "useInfiniteQuery" ||
    exprText === "useSWR" ||
    exprText === "useSWRInfinite" ||
    exprText === "useSubscription"
  ) {
    out.push({ category: "network", line, symbol: exprText, note: "data hook" });
    return;
  }

  // IO — Web Storage APIs.
  if (/^(localStorage|sessionStorage|window\.(localStorage|sessionStorage))\.(getItem|setItem|removeItem|clear)$/.test(exprText)) {
    out.push({ category: "io", line, symbol: exprText, note: "" });
    return;
  }
  // IndexedDB / file APIs would land here too — left for the
  // first customer who needs them, to keep the matcher table
  // honest.
}

// --- package-path classifiers ---
//
// Each returns true when the import path's primary purpose is
// the given category. Kept narrow on purpose; false positives
// here are louder than the call-site classifier since one
// import can dominate a file's signal.

function isNetworkPackage(p: string): boolean {
  if (p === "axios" || p === "ky" || p === "got" || p === "node-fetch") return true;
  if (p === "@tanstack/react-query" || p === "react-query" || p === "swr") return true;
  if (p === "@apollo/client" || p === "urql" || p === "graphql-request") return true;
  return false;
}

function isDataAccessPackage(p: string): boolean {
  if (p === "@prisma/client" || p === "prisma") return true;
  if (p.startsWith("drizzle-orm")) return true;
  if (p === "mongoose" || p === "mongodb") return true;
  if (p === "pg" || p === "pg-promise" || p === "postgres") return true;
  if (p === "ioredis" || p === "redis") return true;
  if (p === "knex") return true;
  return false;
}

function isIOPackage(p: string): boolean {
  if (p === "fs" || p === "node:fs" || p === "fs/promises" || p === "node:fs/promises") return true;
  if (p === "fs-extra" || p === "graceful-fs") return true;
  if (p === "path" || p === "node:path") return false; // path math is not IO
  if (p === "os" || p === "node:os") return true;
  return false;
}

function isTransportPackage(p: string): boolean {
  if (p === "next/server" || p === "next") return true; // App Router server side
  if (p === "express" || p === "@hono/node-server" || p === "hono") return true;
  if (p === "fastify" || p === "koa") return true;
  return false;
}

// trim caps a string's length at `max`, appending an ellipsis
// when truncated. Used to keep symbol strings in evidence
// bounded — a 200-char expression makes the finding body
// unreadable.
function trim(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

// --- classifiers ---

function classifyFunctionAsComponentOrHook(fn: FunctionDeclaration, name: string): DeclKind {
  if (isHookName(name)) return "hook";
  if (isComponentName(name) && functionReturnsJsx(fn)) return "component";
  return "function";
}

function classifyVariableDeclKind(
  init: Node | undefined,
  name: string,
  vstmt: VariableStatement,
): DeclKind {
  const declKind = vstmt.getDeclarationKind(); // "const" | "let" | "var"
  // Hook check trumps everything (we trust naming convention).
  if (isHookName(name) && init && isCallableInitializer(init)) {
    return "hook";
  }
  // Component check.
  if (isComponentName(name) && init && isCallableInitializer(init) && bodyReturnsJsx(init)) {
    return "component";
  }
  return declKind === "const" ? "const" : "var";
}

function classifyClass(cls: ClassDeclaration, name: string): DeclKind {
  if (!isComponentName(name)) return "class";
  // Heuristic: a class is a React component if it extends from
  // something whose name looks like "Component" / "PureComponent" /
  // ends with ".Component". This catches the common
  // `class Foo extends React.Component` and `class Foo extends Component`
  // forms without requiring full type resolution.
  const extName = cls.getExtends()?.getExpression().getText() ?? "";
  if (/(^|\.)Component$/.test(extName) || extName === "PureComponent") {
    return "component";
  }
  return "class";
}

function isComponentName(name: string): boolean {
  return /^[A-Z]/.test(name);
}

function isHookName(name: string): boolean {
  return /^use[A-Z0-9]/.test(name);
}

// isCallableInitializer returns true when the variable's initializer
// is something that can act as a function body — arrow function,
// function expression, or a call to a HOC-ish wrapper (memo, forwardRef,
// observer) whose argument is itself a function. The HOC case catches
// `export const Foo = memo(() => <div/>)` which is idiomatic React.
function isCallableInitializer(node: Node): boolean {
  if (node.isKind(SyntaxKind.ArrowFunction) || node.isKind(SyntaxKind.FunctionExpression)) {
    return true;
  }
  if (node.isKind(SyntaxKind.CallExpression)) {
    const fnText = node.getExpression().getText();
    if (/^(React\.)?(memo|forwardRef|observer|withRouter|connect|withTranslation)$/.test(fnText)) {
      const first = node.getArguments()[0];
      return first !== undefined && isCallableInitializer(first);
    }
  }
  return false;
}

// functionReturnsJsx checks whether the function body returns JSX in
// any of its return positions. Walks descendants once.
function functionReturnsJsx(fn: FunctionDeclaration): boolean {
  return bodyReturnsJsx(fn);
}

// bodyReturnsJsx is the shared "does this function body produce JSX"
// check used by both function declarations and arrow / function-
// expression initializers.
function bodyReturnsJsx(node: Node): boolean {
  let found = false;
  node.forEachDescendant((child, traversal) => {
    if (found) {
      traversal.stop();
      return;
    }
    const k = child.getKind();
    if (
      k === SyntaxKind.JsxElement ||
      k === SyntaxKind.JsxSelfClosingElement ||
      k === SyntaxKind.JsxFragment
    ) {
      found = true;
      traversal.stop();
    }
  });
  return found;
}

// cyclomatic returns a rough McCabe complexity for the function body.
// Each decision point adds 1. We deliberately undercount (no boolean-
// operator scoring) to match the Go-side cyclomaticComplexity helper.
function cyclomatic(fn: Node): number {
  let score = 1;
  fn.forEachDescendant((child) => {
    switch (child.getKind()) {
      case SyntaxKind.IfStatement:
      case SyntaxKind.ForStatement:
      case SyntaxKind.ForInStatement:
      case SyntaxKind.ForOfStatement:
      case SyntaxKind.WhileStatement:
      case SyntaxKind.DoStatement:
      case SyntaxKind.CaseClause:
      case SyntaxKind.ConditionalExpression: // ternary
      case SyntaxKind.CatchClause:
        score++;
        break;
    }
  });
  return score;
}

// Re-export ts so tests can reference SyntaxKind without re-importing
// ts-morph's deep paths. Not used in production; safe to remove later.
export const _ts = ts;
