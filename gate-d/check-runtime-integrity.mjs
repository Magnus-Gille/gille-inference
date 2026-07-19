#!/usr/bin/env node
// Reject candidate edits that can terminate or rewrite the trusted verifier runtime.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const PROTECTED_MODULES = new Set([
  "assert", "assert/strict", "node:assert", "node:assert/strict", "node:test",
]);
const PROCESS_MODULES = new Set(["node:process", "process"]);
const RUNTIME_LOADER_MODULES = new Set(["node:module", "module"]);
const DYNAMIC_CODE_MODULES = new Set(["node:vm", "vm"]);

function unsafeHarnessModule(module) {
  return module.split(/[\\/]/).some((segment) =>
    [".git", "node_modules", ".arm.log", ".check.log"].includes(segment));
}

function unwrap(node) {
  let value = node;
  while (value && (ts.isParenthesizedExpression(value) || ts.isAsExpression(value) ||
      ts.isTypeAssertionExpression(value) || ts.isSatisfiesExpression(value))) value = value.expression;
  return value;
}

function rootIdentifier(node) {
  let value = unwrap(node);
  while (value && (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value))) {
    value = unwrap(value.expression);
  }
  return value && ts.isIdentifier(value) ? value : undefined;
}

function protectedReference(node, protectedNames) {
  const value = unwrap(node);
  if (!value) return false;
  if (ts.isIdentifier(value)) return protectedNames.has(value.text);
  if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
    const root = rootIdentifier(value);
    return Boolean(root && protectedNames.has(root.text)) ||
      protectedReference(value.expression, protectedNames);
  }
  if (ts.isArrayLiteralExpression(value)) {
    return value.elements.some((element) => !ts.isOmittedExpression(element) &&
      protectedReference(element, protectedNames));
  }
  if (ts.isObjectLiteralExpression(value)) {
    return value.properties.some((property) =>
      (ts.isPropertyAssignment(property) && protectedReference(property.initializer, protectedNames)) ||
      (ts.isShorthandPropertyAssignment(property) && protectedNames.has(property.name.text)) ||
      (ts.isSpreadAssignment(property) && protectedReference(property.expression, protectedNames)));
  }
  if (ts.isConditionalExpression(value)) {
    return protectedReference(value.whenTrue, protectedNames) ||
      protectedReference(value.whenFalse, protectedNames);
  }
  if (ts.isBinaryExpression(value) &&
      (value.operatorToken.kind === ts.SyntaxKind.CommaToken ||
       value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
       value.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
       value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
    return protectedReference(value.left, protectedNames) ||
      protectedReference(value.right, protectedNames);
  }
  return false;
}

function staticString(node) {
  const value = unwrap(node);
  if (!value) return undefined;
  if (ts.isStringLiteralLike(value)) return value.text;
  if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticString(value.left);
    const right = staticString(value.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (ts.isTemplateExpression(value)) {
    let result = value.head.text;
    for (const span of value.templateSpans) {
      const expression = staticString(span.expression);
      if (expression === undefined) return undefined;
      result += expression + span.literal.text;
    }
    return result;
  }
  return undefined;
}

export function runtimeIntegrityViolations(sourceText, file = "candidate.ts") {
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
  const protectedNames = new Set();
  const violations = [];

  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const module = statement.moduleSpecifier.text;
    if (PROCESS_MODULES.has(module)) violations.push(`candidate imports ${module}`);
    if (RUNTIME_LOADER_MODULES.has(module)) {
      violations.push(`candidate imports ${module} runtime loader`);
    }
    if (DYNAMIC_CODE_MODULES.has(module)) violations.push(`candidate imports ${module} dynamic-code runtime`);
    if (unsafeHarnessModule(module)) violations.push(`candidate imports harness-owned path ${module}`);
    if (!PROTECTED_MODULES.has(module) || statement.importClause?.isTypeOnly) continue;
    const clause = statement.importClause;
    if (clause?.name) protectedNames.add(clause.name.text);
    if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      protectedNames.add(clause.namedBindings.name.text);
    }
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) if (!element.isTypeOnly) {
        protectedNames.add(element.name.text);
      }
    }
  }

  function add(node, message) {
    const position = source.getLineAndCharacterOfPosition(node.getStart(source));
    violations.push(`${position.line + 1}:${position.character + 1} ${message}`);
  }

  function visit(node) {
    if (ts.isIdentifier(node) && node.text === "process") {
      add(node, "candidate references process runtime control");
    }
    if (ts.isIdentifier(node) && (node.text === "globalThis" || node.text === "global")) {
      add(node, "candidate references the global runtime object");
    }
    if (ts.isIdentifier(node) && (node.text === "eval" || node.text === "Function") &&
        !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) {
      add(node, "candidate references dynamic code evaluation");
    }
    if (ts.isElementAccessExpression(node)) {
      const receiver = unwrap(node.expression);
      const argument = staticString(node.argumentExpression);
      if (receiver && ts.isIdentifier(receiver) &&
          (receiver.text === "globalThis" || receiver.text === "global") && argument === "process") {
        add(node, "candidate references global process runtime control");
      }
    }
    if (ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
        protectedReference(node.left, protectedNames)) {
      add(node, "candidate mutates a trusted Node assertion/test binding");
    }
    if (ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
        protectedReference(node.right, protectedNames)) {
      add(node, "candidate aliases or escapes a trusted Node assertion/test binding");
    }
    if (ts.isDeleteExpression(node) && protectedReference(node.expression, protectedNames)) {
      add(node, "candidate deletes from a trusted Node assertion/test binding");
    }
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        protectedReference(node.operand, protectedNames)) {
      add(node, "candidate updates a trusted Node assertion/test binding");
    }
    if (ts.isVariableDeclaration(node) && node.initializer &&
        protectedReference(node.initializer, protectedNames)) {
      const value = unwrap(node.initializer);
      if (value && (ts.isIdentifier(value) || ts.isPropertyAccessExpression(value) ||
          ts.isElementAccessExpression(value) || ts.isArrayLiteralExpression(value) ||
          ts.isObjectLiteralExpression(value))) {
        add(node, "candidate aliases a trusted Node assertion/test binding");
      }
    }
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) &&
        (node.arguments ?? []).some((argument) => protectedReference(argument, protectedNames))) {
      add(node, "candidate escapes a trusted Node assertion/test binding");
    }
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      const module = node.arguments.length === 1 ? staticString(node.arguments[0]) : undefined;
      const dynamicImport = callee?.kind === ts.SyntaxKind.ImportKeyword;
      const commonJsRequire = callee && ts.isIdentifier(callee) && callee.text === "require";
      if ((dynamicImport || commonJsRequire) && module &&
          (PROTECTED_MODULES.has(module) || PROCESS_MODULES.has(module) ||
           RUNTIME_LOADER_MODULES.has(module) || DYNAMIC_CODE_MODULES.has(module) ||
           unsafeHarnessModule(module))) {
        add(node, `candidate dynamically loads protected runtime module ${module}`);
      }
      const member = ts.isPropertyAccessExpression(callee) ? callee.name.text
        : ts.isElementAccessExpression(callee) ? staticString(callee.argumentExpression) : undefined;
      if (member === "constructor") add(node, "candidate invokes a reflective code constructor");
    }
    if (ts.isArrowFunction(node) && !ts.isBlock(node.body) &&
        protectedReference(node.body, protectedNames)) {
      add(node, "candidate returns a trusted Node assertion/test binding");
    }
    if (ts.isReturnStatement(node) && node.expression &&
        protectedReference(node.expression, protectedNames)) {
      add(node, "candidate returns a trusted Node assertion/test binding");
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return [...new Set(violations)];
}

function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error("usage: check-runtime-integrity.mjs <candidate-file> [...]");
    process.exit(2);
  }
  let failed = false;
  for (const file of files) {
    const violations = runtimeIntegrityViolations(readFileSync(file, "utf8"), file);
    if (violations.length > 0) {
      failed = true;
      for (const violation of violations) console.error(`${file}:${violation}`);
    }
  }
  if (failed) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
