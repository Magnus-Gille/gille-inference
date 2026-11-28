#!/usr/bin/env node
// gate-d-r3 I/O gate (Codex reviews on PR #14). check.sh stages the hidden oracle into the workspace and
// runs it in the same process as the candidate's modules, so a candidate module that can read files
// could read the oracle at import time and tailor its exports to the hidden cases. No gate-d-r3 task
// needs anything but its own modules (and node:test / node:assert in tests), so this is an ALLOWLIST:
//   - runtime imports in src/: relative `.ts` modules inside the workspace only;
//   - runtime imports in test/: the same, plus node:test, node:assert, node:assert/strict;
//   - no references to process, globalThis, global, require, module, eval, Function, Bun, Deno;
//   - no computed import()/require, no import.meta.resolve.
// Type-only imports are erased and allowed. Installed packages are never importable: typescript
// alone exposes ts.sys.readFile. A denylist cannot close `(()=>{}).constructor("…")`, so the
// verifier also runs node with --disallow-code-generation-from-strings (harbor/test.sh).
// Static analysis only: nothing is executed.
//
// Usage: node io-gate.mjs <TOOLCHAIN_NODE_MODULES> <SEED_REPO> <WORKDIR>
// Exit 0 = clean, 1 = violations (printed), 2 = bad arguments.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const [toolchain, seed, work] = process.argv.slice(2);
if (!toolchain || !seed || !work) {
  console.error("usage: io-gate.mjs <toolchain-node_modules> <seed-repo> <workdir>");
  process.exit(2);
}
const ts = createRequire(path.join(toolchain, "noop.js"))("typescript");

const TEST_BUILTINS = new Set(["node:test", "node:assert", "node:assert/strict"]);
const BANNED_IDENTIFIERS = new Set(["process", "globalThis", "global", "require", "module", "eval", "Function",
  "Bun", "Deno"]);
const CODE = /\.(?:[cm]?[jt]s|tsx|jsx)$/;
const WORK_ROOT = path.resolve(work);

function allowed(spec, rel) {
  if (TEST_BUILTINS.has(spec)) return rel.startsWith("test/");
  if (!spec.startsWith("./") && !spec.startsWith("../")) return false;
  if (!spec.endsWith(".ts") || /oracle/i.test(spec) || /(^|[\\/])node_modules([\\/]|$)/.test(spec)) return false;
  const target = path.resolve(WORK_ROOT, path.dirname(rel), spec);
  return target.startsWith(WORK_ROOT + path.sep);
}

function* files(dir, rel = "") {
  for (const name of readdirSync(path.join(dir, rel))) {
    if (rel === "" && (name === "node_modules" || name === ".git")) continue;
    const r = rel === "" ? name : `${rel}/${name}`;
    const st = statSync(path.join(dir, r), { throwIfNoEntry: false });
    if (st?.isDirectory()) yield* files(dir, r);
    else if (st?.isFile() && CODE.test(name)) yield r;
  }
}

function staticSpec(node) {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
}

function typeOnly(n) {
  if (ts.isImportDeclaration(n)) {
    const c = n.importClause;
    if (!c) return false; // `import "x"` runs x
    if (c.isTypeOnly) return true;
    const named = c.namedBindings && ts.isNamedImports(c.namedBindings) ? c.namedBindings : undefined;
    return !c.name && named !== undefined && named.elements.length > 0 && named.elements.every((e) => e.isTypeOnly);
  }
  if (ts.isExportDeclaration(n)) return n.isTypeOnly;
  return false;
}

function violations(rel, text) {
  const out = [];
  const src = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
  const at = (n, msg) => {
    const p = src.getLineAndCharacterOfPosition(n.getStart(src));
    out.push(`${rel}:${p.line + 1}:${p.character + 1} ${msg}`);
  };
  const visit = (n) => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && !typeOnly(n)) {
      const s = staticSpec(n.moduleSpecifier);
      if (s === undefined || !allowed(s, rel)) at(n, `imports ${s ?? "a computed module"} (not on the allowlist)`);
    }
    if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && !n.isTypeOnly) {
      at(n, "uses import = require()");
    }
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const s = staticSpec(n.arguments[0]);
      if (s === undefined || !allowed(s, rel)) at(n, `import() of ${s ?? "a computed module"} (not on the allowlist)`);
    }
    if (ts.isIdentifier(n) && BANNED_IDENTIFIERS.has(n.text)) {
      const p = n.parent;
      // `x.process` / `{ process: 1 }` / `type T = { module: … }` name a property, not the global.
      const isPropertyName = (ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n)
        || (ts.isPropertySignature(p) && p.name === n) || (ts.isPropertyDeclaration(p) && p.name === n)
        || (ts.isMethodDeclaration(p) && p.name === n) || (ts.isQualifiedName(p) && p.right === n)
        || (ts.isBindingElement(p) && p.propertyName === n);
      if (!isPropertyName) at(n, `references ${n.text}`);
    }
    if (ts.isMetaProperty(n) && n.keywordToken === ts.SyntaxKind.ImportKeyword && ts.isPropertyAccessExpression(n.parent)
        && n.parent.name.text === "resolve") at(n, "uses import.meta.resolve");
    ts.forEachChild(n, visit);
  };
  visit(src);
  return out;
}

const found = [];
for (const rel of files(work)) {
  const text = readFileSync(path.join(work, rel), "utf8");
  const pristine = path.join(seed, rel);
  if (existsSync(pristine) && readFileSync(pristine, "utf8") === text) continue; // seed files are trusted
  found.push(...violations(rel, text));
}
if (found.length > 0) {
  for (const v of found) console.log(`FAIL[R3-io]: ${v}`);
  process.exit(1);
}
