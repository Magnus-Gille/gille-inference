#!/usr/bin/env node
// Content-independent AST gate for TDD fixtures. Counts executed subject assertions, not lines.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const ASSERT_METHODS = new Set([
  "equal", "strictEqual", "deepEqual", "deepStrictEqual",
  "notEqual", "notStrictEqual", "notDeepEqual", "notDeepStrictEqual",
  "ok", "match", "doesNotMatch", "throws", "doesNotThrow",
  "rejects", "doesNotReject", "ifError", "fail",
]);
const CALLBACK_ASSERT_METHODS = new Set(["throws", "doesNotThrow", "rejects", "doesNotReject"]);

export function analyzeAssertions(sourceText, subject, minimum, file = "subject.test.ts") {
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);

  function unwrapExpression(node) {
    let current = node;
    while (current && (ts.isAsExpression(current) || ts.isTypeAssertionExpression(current) ||
      ts.isParenthesizedExpression(current) || ts.isSatisfiesExpression(current))) {
      current = current.expression;
    }
    return current;
  }

  // All trusted names are resolved to lexical declaration identities. A local shadow therefore
  // cannot inherit trust from a same-named import, and duplicate declarations fail closed.
  const scopeBindings = new WeakMap();
  const scopeParents = new WeakMap();
  const nodeScopes = new WeakMap();

  function bindingMap(scope) {
    let map = scopeBindings.get(scope);
    if (!map) { map = new Map(); scopeBindings.set(scope, map); }
    return map;
  }

  function declareIdentifier(scope, identifier, details = {}) {
    const info = { identifier, scope, mutated: false, ...details };
    const map = bindingMap(scope);
    const entries = map.get(identifier.text) ?? [];
    entries.push(info);
    map.set(identifier.text, entries);
    return info;
  }

  function declareName(scope, name, details = {}, found = []) {
    if (ts.isIdentifier(name)) found.push(declareIdentifier(scope, name, details));
    else for (const element of name.elements) {
      if (ts.isBindingElement(element)) declareName(scope, element.name, details, found);
    }
    return found;
  }

  function isLexicalScope(node) {
    return ts.isFunctionLike(node) || ts.isBlock(node) || ts.isCatchClause(node) ||
      ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node);
  }

  function literalArrayLength(node) {
    const value = unwrapExpression(node);
    return value && ts.isArrayLiteralExpression(value) &&
      value.elements.every((element) => !ts.isSpreadElement(element))
      ? value.elements.length : undefined;
  }

  function literalForEachLength(node) {
    const value = unwrapExpression(node);
    return value && ts.isArrayLiteralExpression(value) &&
      value.elements.every((element) => !ts.isSpreadElement(element) && !ts.isOmittedExpression(element))
      ? value.elements.length : undefined;
  }

  function registerImport(node, scope) {
    if (!ts.isStringLiteral(node.moduleSpecifier) || node.importClause?.isTypeOnly) return;
    const module = node.moduleSpecifier.text;
    const clause = node.importClause;
    const imported = (identifier, importedName, extra = {}) => declareIdentifier(scope, identifier, {
      kind: "import", module, importedName, ...extra,
      subjectImport: importedName === subject || (importedName === "default" && identifier.text === subject),
    });
    if (clause?.name) {
      imported(clause.name, "default", {
        assertObject: ["node:assert", "node:assert/strict"].includes(module),
        assertCallable: ["node:assert", "node:assert/strict"].includes(module),
        runner: module === "node:test",
        testContextRunner: module === "node:test",
      });
    }
    if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      imported(clause.namedBindings.name, "*", {
        assertObject: ["node:assert", "node:assert/strict"].includes(module),
        testNamespace: module === "node:test",
      });
    }
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        if (element.isTypeOnly) continue;
        const importedName = element.propertyName?.text ?? element.name.text;
        const isRunner = module === "node:test" && ["test", "it", "describe", "suite"].includes(importedName);
        imported(element.name, importedName, {
          assertObject: ["node:assert", "node:assert/strict"].includes(module) && importedName === "strict",
          assertCallable: ["node:assert", "node:assert/strict"].includes(module) && importedName === "strict",
          assertMethod: ["node:assert", "node:assert/strict"].includes(module) && ASSERT_METHODS.has(importedName)
            ? importedName : undefined,
          runner: isRunner,
          testContextRunner: isRunner && ["test", "it"].includes(importedName),
        });
      }
    }
  }

  function collectBindings(node, currentScope = source) {
    // Declaration names for functions/classes live in the enclosing scope, not their body scope.
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
      declareIdentifier(currentScope, node.name, { kind: ts.isFunctionDeclaration(node) ? "function" : "class" });
    }
    let activeScope = currentScope;
    if (node !== source && isLexicalScope(node)) {
      activeScope = node;
      scopeParents.set(activeScope, currentScope);
      bindingMap(activeScope);
    }
    nodeScopes.set(node, activeScope);

    if (ts.isImportDeclaration(node)) registerImport(node, activeScope);
    if (ts.isVariableDeclaration(node)) {
      declareName(activeScope, node.name, {
        kind: "variable",
        initializer: node.initializer,
        arrayLength: node.initializer ? literalArrayLength(node.initializer) : undefined,
        forEachLength: node.initializer ? literalForEachLength(node.initializer) : undefined,
      });
    }
    if (ts.isParameter(node)) declareName(activeScope, node.name, { kind: "parameter" });
    if (ts.isFunctionExpression(node) && node.name) {
      declareIdentifier(activeScope, node.name, { kind: "function" });
    }
    ts.forEachChild(node, (child) => collectBindings(child, activeScope));
  }
  bindingMap(source);
  collectBindings(source);

  function resolveBinding(identifier) {
    let scope = nodeScopes.get(identifier) ?? source;
    while (scope) {
      const entries = bindingMap(scope).get(identifier.text);
      if (entries) return entries.length === 1 ? entries[0] : null;
      scope = scopeParents.get(scope);
    }
    return null;
  }

  function invalidateArrayBinding(identifier) {
    const binding = resolveBinding(identifier);
    if (binding) binding.mutated = true;
  }

  function rootIdentifier(node) {
    let value = unwrapExpression(node);
    while (value && (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value))) {
      value = unwrapExpression(value.expression);
    }
    return value && ts.isIdentifier(value) ? value : undefined;
  }

  function invalidateTrustRoot(node) {
    const root = rootIdentifier(node);
    const binding = root ? resolveBinding(root) : null;
    if (binding) binding.trustMutated = true;
  }

  function invalidateEscapedTrust(node) {
    function visit(child) {
      if (ts.isFunctionLike(child) || ts.isClassLike(child) || ts.isCallExpression(child)) return;
      if (ts.isIdentifier(child)) {
        const binding = resolveBinding(child);
        if (binding && (binding.assertObject || binding.assertCallable || binding.runner ||
            binding.testNamespace || binding.testContextRunner)) binding.trustMutated = true;
      }
      ts.forEachChild(child, visit);
    }
    visit(node);
  }

  let arrayPrototypeForEachMutated = false;

  function staticMemberName(node) {
    const value = unwrapExpression(node);
    if (value && ts.isPropertyAccessExpression(value)) return value.name.text;
    if (value && ts.isElementAccessExpression(value)) {
      const argument = unwrapExpression(value.argumentExpression);
      if (argument && ts.isStringLiteralLike(argument)) return argument.text;
    }
    return undefined;
  }

  function invalidateReferencedArrays(node) {
    function visit(child) {
      if (ts.isFunctionLike(child) || ts.isClassLike(child)) return;
      if (ts.isIdentifier(child)) {
        const binding = resolveBinding(child);
        if (binding?.arrayLength !== undefined) binding.mutated = true;
      }
      ts.forEachChild(child, visit);
    }
    visit(node);
  }

  function collectMutations(node) {
    // Any reference to the ambient Array prototype makes native forEach execution unprovable.
    // This intentionally rejects benign reflection too: aliases, computed writes, and
    // Object.defineProperty/Reflect.set can otherwise replace forEach invisibly to the table.
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
        ["prototype", "__proto__"].includes(staticMemberName(node))) {
      arrayPrototypeForEachMutated = true;
    }
    if (ts.isCallExpression(node) && staticMemberName(node.expression) === "getPrototypeOf") {
      arrayPrototypeForEachMutated = true;
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const alias = unwrapExpression(node.initializer);
      if (alias && ts.isIdentifier(alias)) invalidateArrayBinding(alias);
      if (alias && (ts.isIdentifier(alias) || ts.isArrayLiteralExpression(alias) ||
          ts.isObjectLiteralExpression(alias))) invalidateEscapedTrust(alias);
      if (alias && (ts.isArrayLiteralExpression(alias) || ts.isObjectLiteralExpression(alias))) {
        invalidateReferencedArrays(alias);
      }
    }
    if (ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      if (ts.isIdentifier(node.left)) invalidateArrayBinding(node.left);
      const alias = unwrapExpression(node.right);
      if (alias && ts.isIdentifier(alias)) invalidateArrayBinding(alias);
      if ((ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left)) &&
          ts.isIdentifier(node.left.expression)) invalidateArrayBinding(node.left.expression);
      if (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left)) {
        invalidateTrustRoot(node.left);
      }
      if (ts.isPropertyAccessExpression(node.left) && node.left.name.text === "forEach" &&
          ts.isPropertyAccessExpression(node.left.expression) && node.left.expression.name.text === "prototype" &&
          ts.isIdentifier(node.left.expression.expression) && node.left.expression.expression.text === "Array" &&
          resolveBinding(node.left.expression.expression) === null) arrayPrototypeForEachMutated = true;
    }
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        (ts.isPropertyAccessExpression(node.operand) || ts.isElementAccessExpression(node.operand)) &&
        ts.isIdentifier(node.operand.expression)) invalidateArrayBinding(node.operand.expression);
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        (ts.isPropertyAccessExpression(node.operand) || ts.isElementAccessExpression(node.operand))) {
      invalidateTrustRoot(node.operand);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        ["push", "pop", "shift", "unshift", "splice", "copyWithin", "fill", "reverse", "sort"].includes(node.expression.name.text)) {
      invalidateArrayBinding(node.expression.expression);
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      for (const argument of node.arguments ?? []) {
        invalidateReferencedArrays(argument);
        invalidateEscapedTrust(argument);
      }
    }
    if (ts.isDeleteExpression(node) &&
        (ts.isPropertyAccessExpression(unwrapExpression(node.expression)) ||
         ts.isElementAccessExpression(unwrapExpression(node.expression)))) {
      invalidateTrustRoot(node.expression);
    }
    if (ts.isReturnStatement(node) && node.expression) {
      invalidateReferencedArrays(node.expression);
      invalidateEscapedTrust(node.expression);
    }
    if (ts.isPropertyAssignment(node)) {
      invalidateReferencedArrays(node.initializer);
      invalidateEscapedTrust(node.initializer);
    }
    if (ts.isShorthandPropertyAssignment(node)) {
      invalidateArrayBinding(node.name);
      invalidateEscapedTrust(node.name);
    }
    ts.forEachChild(node, collectMutations);
  }
  collectMutations(source);

  function staticArrayLength(node) {
    const value = unwrapExpression(node);
    if (!value) return undefined;
    if (ts.isArrayLiteralExpression(value)) {
      return value.elements.every((element) => !ts.isSpreadElement(element))
        ? value.elements.length : undefined;
    }
    if (ts.isIdentifier(value)) {
      const binding = resolveBinding(value);
      return binding && !binding.mutated ? binding.arrayLength : undefined;
    }
    return undefined;
  }

  function staticForEachLength(node) {
    if (arrayPrototypeForEachMutated) return undefined;
    const value = unwrapExpression(node);
    if (!value) return undefined;
    if (ts.isArrayLiteralExpression(value)) return literalForEachLength(value);
    if (ts.isIdentifier(value)) {
      const binding = resolveBinding(value);
      return binding && !binding.mutated ? binding.forEachLength : undefined;
    }
    return undefined;
  }

  function bindingNames(name, names = new Set()) {
    if (ts.isIdentifier(name)) {
      const binding = resolveBinding(name);
      if (binding) names.add(binding);
    }
    else for (const element of name.elements) {
      if (ts.isBindingElement(element)) bindingNames(element.name, names);
    }
    return names;
  }

  function callbackBody(node, loopMultiplier, testContexts, isTestCallback = false, callbackKind = "test") {
    if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return;
    if (node.asteriskToken) return;
    if (callbackKind === "forEach" && node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) return;
    const contexts = new Set(testContexts);
    if (isTestCallback && node.parameters[0] && ts.isIdentifier(node.parameters[0].name)) {
      const binding = resolveBinding(node.parameters[0].name);
      if (binding) contexts.add(binding);
    }
    const effectiveMultiplier = containsContextDisableCall(node.body, contexts) ? 0 : loopMultiplier;
    if (ts.isBlock(node.body)) {
      visitStatement(node.body, effectiveMultiplier, contexts);
    } else {
      visitExpression(node.body, effectiveMultiplier, contexts);
    }
  }

  function containsContextDisableCall(node, contexts) {
    let found = false;
    function visit(child, root = false) {
      if (found || (!root && (ts.isFunctionLike(child) || ts.isClassLike(child)))) return;
      if (ts.isCallExpression(child) && ts.isPropertyAccessExpression(child.expression) &&
          ["skip", "todo"].includes(child.expression.name.text) &&
          ts.isIdentifier(child.expression.expression) &&
          contexts.has(resolveBinding(child.expression.expression))) {
        found = true;
        return;
      }
      ts.forEachChild(child, (nested) => visit(nested));
    }
    visit(node, true);
    return found;
  }

  function isKnownCallbackRunner(call) {
    if (ts.isIdentifier(call.expression)) {
      const binding = resolveBinding(call.expression);
      return binding?.runner === true && binding.trustMutated !== true;
    }
    if (!ts.isPropertyAccessExpression(call.expression) || !ts.isIdentifier(call.expression.expression)) return false;
    const binding = resolveBinding(call.expression.expression);
    if (binding?.trustMutated === true) return false;
    return (binding?.testNamespace === true && ["test", "it", "describe", "suite"].includes(call.expression.name.text)) ||
      (binding?.runner === true && ["only", "skip", "todo"].includes(call.expression.name.text));
  }

  function isTestContextRunner(call) {
    if (ts.isIdentifier(call.expression)) {
      const binding = resolveBinding(call.expression);
      return binding?.testContextRunner === true && binding.trustMutated !== true;
    }
    if (!ts.isPropertyAccessExpression(call.expression) || !ts.isIdentifier(call.expression.expression)) return false;
    const binding = resolveBinding(call.expression.expression);
    if (binding?.trustMutated === true) return false;
    return (binding?.testNamespace === true && ["test", "it"].includes(call.expression.name.text)) ||
      (binding?.testContextRunner === true && ["only", "skip", "todo"].includes(call.expression.name.text));
  }

  function runnerIsDisabled(call) {
    if (ts.isPropertyAccessExpression(call.expression) && ["skip", "todo"].includes(call.expression.name.text)) {
      return true;
    }
    function propertyName(name) {
      if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
      if (ts.isComputedPropertyName(name)) {
        const value = unwrapExpression(name.expression);
        if (value && ts.isStringLiteral(value)) return value.text;
      }
      return undefined;
    }
    function optionsDisabled(node, seen = new Set()) {
      const value = unwrapExpression(node);
      if (!value) return undefined;
      if (ts.isIdentifier(value)) {
        const binding = resolveBinding(value);
        if (!binding || binding.mutated || seen.has(binding) || !binding.initializer) return undefined;
        seen.add(binding);
        return optionsDisabled(binding.initializer, seen);
      }
      if (!ts.isObjectLiteralExpression(value)) return undefined;
      if (value.properties.some(ts.isSpreadAssignment)) return true;
      for (const property of value.properties) {
        const name = propertyName(property.name);
        if (name === "__proto__") return true;
        if (ts.isShorthandPropertyAssignment(property) && ["skip", "todo"].includes(property.name.text)) {
          return true; // unknown runtime binding may disable or de-enforce the callback
        }
        if (!["skip", "todo"].includes(name)) continue;
        if (!ts.isPropertyAssignment(property) || staticTruthiness(property.initializer) !== false) return true;
      }
      return false;
    }
    const callbackIndex = call.arguments.findIndex((argument) =>
      ts.isArrowFunction(argument) || ts.isFunctionExpression(argument));
    return call.arguments.some((argument, index) => {
      if (index === callbackIndex) return false;
      const value = unwrapExpression(argument);
      if (index === 0 && value && (ts.isStringLiteralLike(value) || ts.isNoSubstitutionTemplateLiteral(value))) {
        return false; // test name
      }
      const disabled = optionsDisabled(argument);
      return disabled !== false; // unknown options may disable/de-enforce the callback
    });
  }

  function forEachLength(call) {
    if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== "forEach") return undefined;
    return staticForEachLength(call.expression.expression);
  }

  function assertMethod(node, testContexts) {
    if (!ts.isCallExpression(node)) return undefined;
    if (ts.isIdentifier(node.expression)) {
      const binding = resolveBinding(node.expression);
      if (binding?.trustMutated === true) return undefined;
      if (binding?.assertMethod) return binding.assertMethod;
      if (binding?.assertCallable) return "ok";
    }
    if (!ts.isPropertyAccessExpression(node.expression) || !ASSERT_METHODS.has(node.expression.name.text)) {
      return undefined;
    }
    const receiver = node.expression.expression;
    if (ts.isIdentifier(receiver)) {
      const binding = resolveBinding(receiver);
      if (binding?.assertObject === true && binding.trustMutated !== true) return node.expression.name.text;
    }
    if (ts.isPropertyAccessExpression(receiver) && receiver.name.text === "strict" &&
        ts.isIdentifier(receiver.expression)) {
      const binding = resolveBinding(receiver.expression);
      if (binding?.assertObject === true && binding.trustMutated !== true) return node.expression.name.text;
    }
    if (ts.isPropertyAccessExpression(receiver) && receiver.name.text === "assert" &&
        ts.isIdentifier(receiver.expression)) {
      const binding = resolveBinding(receiver.expression);
      if (testContexts.has(binding) && binding?.trustMutated !== true) return node.expression.name.text;
    }
    return undefined;
  }

  function isSubjectCall(node) {
    return ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
      resolveBinding(node.expression)?.subjectImport === true;
  }

  function containsBinding(node, names) {
    let found = false;
    function visit(child) {
      if (ts.isIdentifier(child) && names.has(resolveBinding(child)) &&
          !(ts.isPropertyAccessExpression(child.parent) && child.parent.name === child)) found = true;
      if (!found) ts.forEachChild(child, visit);
    }
    visit(node);
    return found;
  }

  function statementMayAbrupt(statement) {
    if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement) ||
        ts.isBreakStatement(statement) || ts.isContinueStatement(statement)) return true;
    if (ts.isBlock(statement)) return statement.statements.some(statementMayAbrupt);
    if (ts.isIfStatement(statement)) {
      const condition = staticBoolean(statement.expression);
      if (condition === true) return statementMayAbrupt(statement.thenStatement);
      if (condition === false) return statement.elseStatement ? statementMayAbrupt(statement.elseStatement) : false;
      return statementMayAbrupt(statement.thenStatement) ||
        (statement.elseStatement ? statementMayAbrupt(statement.elseStatement) : false);
    }
    return ts.isSwitchStatement(statement) || ts.isTryStatement(statement) ||
      ts.isIterationStatement(statement, false);
  }

  function guaranteedMatchingCall(node, matches, callbackMode = "none") {
    function guaranteedStatements(statements) {
      for (const statement of statements) {
        if (guaranteedStatement(statement)) return true;
        if (statementMayAbrupt(statement)) return false;
      }
      return false;
    }
    function guaranteedStatement(statement) {
      if (ts.isExpressionStatement(statement)) return visit(statement.expression, false);
      if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) {
        return statement.expression ? visit(statement.expression, false) : false;
      }
      if (ts.isBlock(statement)) return guaranteedStatements(statement.statements);
      if (ts.isIfStatement(statement)) {
        if (visit(statement.expression, false)) return true;
        const condition = staticBoolean(statement.expression);
        if (condition === true) return guaranteedStatement(statement.thenStatement);
        if (condition === false) return statement.elseStatement ? guaranteedStatement(statement.elseStatement) : false;
        return Boolean(statement.elseStatement) && guaranteedStatement(statement.thenStatement) &&
          guaranteedStatement(statement.elseStatement);
      }
      return false; // unsupported control flow never recursively promotes nested syntax
    }
    function visit(child, allowRootFunction) {
      const value = unwrapExpression(child) ?? child;
      if (ts.isFunctionLike(value)) {
        if (!allowRootFunction || callbackMode === "none" || value.asteriskToken) return false;
        const isAsync = value.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
        if (isAsync && callbackMode !== "await") return false;
        return ts.isBlock(value.body) ? guaranteedStatements(value.body.statements) : visit(value.body, false);
      }
      if (ts.isClassLike(value)) return false;
      if (ts.isCallExpression(value) && matches(value)) return true;
      if (ts.isBinaryExpression(value) &&
          (value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
           value.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
           value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
        const inLeft = visit(value.left, false);
        if (inLeft) return true;
        if (value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
          const primitive = staticPrimitive(value.left);
          return primitive === null ? visit(value.right, false) : false;
        }
        const left = staticBoolean(value.left);
        const isAnd = value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken;
        return ((isAnd && left === true) || (!isAnd && left === false)) && visit(value.right, false);
      }
      if (ts.isConditionalExpression(value)) {
        if (visit(value.condition, false)) return true;
        const condition = staticBoolean(value.condition);
        if (condition === true) return visit(value.whenTrue, false);
        if (condition === false) return visit(value.whenFalse, false);
        return visit(value.whenTrue, false) && visit(value.whenFalse, false);
      }
      if (ts.isCallExpression(value) && callArgumentsMayBeSkipped(value)) return visit(value.expression, false);
      let guaranteed = false;
      ts.forEachChild(value, (nested) => { if (!guaranteed) guaranteed = visit(nested, false); });
      return guaranteed;
    }
    return visit(node, callbackMode !== "none");
  }

  function containsSubjectCall(node, callbackMode = "none") {
    return guaranteedMatchingCall(node, isSubjectCall, callbackMode);
  }

  function subjectCallContainsBinding(node, names, callbackMode = "none") {
    return guaranteedMatchingCall(node, (call) => isSubjectCall(call) &&
      call.arguments.some((argument) => containsBinding(argument, names)), callbackMode);
  }

  function bindingFlowsIntoSubjectAssertion(node, names, testContexts) {
    if (names.size === 0) return false;
    // Follow simple local aliases so `const input = row; assert(subject(input))` remains a
    // legitimate table-driven case without turning an invariant repeated assertion into N cases.
    let changed = true;
    while (changed) {
      changed = false;
      function collectAliases(child) {
        if (ts.isVariableDeclaration(child) && ts.isIdentifier(child.name) && child.initializer &&
            containsBinding(child.initializer, names)) {
          const binding = resolveBinding(child.name);
          if (binding && !names.has(binding)) { names.add(binding); changed = true; }
        }
        if (!ts.isFunctionLike(child)) ts.forEachChild(child, collectAliases);
      }
      collectAliases(node);
    }
    let found = false;
    function visit(child, root = false) {
      if (found || (!root && ts.isFunctionLike(child))) return;
      const method = assertMethod(child, testContexts);
      if (method && child.arguments.some((argument) =>
        subjectCallContainsBinding(argument, names, callbackModeForAssert(method)))) {
        found = true;
        return;
      }
      ts.forEachChild(child, (nested) => visit(nested));
    }
    visit(node, true);
    return found;
  }

  function staticBoolean(node) {
    const value = unwrapExpression(node);
    if (value?.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (value?.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (value && ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.ExclamationToken) {
      const operand = staticBoolean(value.operand);
      return operand === undefined ? undefined : !operand;
    }
    if (value && ts.isBinaryExpression(value) &&
        (value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
         value.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
      const left = staticBoolean(value.left);
      const right = staticBoolean(value.right);
      if (value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
        if (left === false || right === false) return false;
        if (left === true && right === true) return true;
      } else {
        if (left === true || right === true) return true;
        if (left === false && right === false) return false;
      }
    }
    if (value && ts.isConditionalExpression(value)) {
      const condition = staticBoolean(value.condition);
      if (condition === true) return staticBoolean(value.whenTrue);
      if (condition === false) return staticBoolean(value.whenFalse);
      const yes = staticBoolean(value.whenTrue);
      const no = staticBoolean(value.whenFalse);
      return yes !== undefined && yes === no ? yes : undefined;
    }
    return undefined;
  }

  function staticPrimitive(node) {
    const value = unwrapExpression(node);
    if (value && (ts.isStringLiteral(value) || ts.isNumericLiteral(value))) return value.text;
    if (value?.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (value?.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (value?.kind === ts.SyntaxKind.NullKeyword) return null;
    return undefined;
  }

  function staticTruthiness(node) {
    const boolean = staticBoolean(node);
    if (boolean !== undefined) return boolean;
    const value = unwrapExpression(node);
    if (value && ts.isStringLiteralLike(value)) return value.text.length > 0;
    if (value && ts.isNoSubstitutionTemplateLiteral(value)) return value.text.length > 0;
    if (value?.kind === ts.SyntaxKind.NullKeyword) return false;
    return undefined;
  }

  function callbackModeForAssert(method) {
    if (["rejects", "doesNotReject"].includes(method)) return "await";
    if (["throws", "doesNotThrow"].includes(method)) return "sync";
    return "none";
  }

  function callArgumentsMayBeSkipped(call) {
    let current = call;
    while (current) {
      if (current.questionDotToken || (current.flags & ts.NodeFlags.OptionalChain) !== 0) return true;
      if (ts.isCallExpression(current) || ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
        current = current.expression;
      } else break;
    }
    return false;
  }

  function isAbruptProcessCall(node) {
    if (!ts.isCallExpression(node)) return false;
    const abruptNames = new Set(["exit", "abort", "reallyExit"]);
    function memberName(value) {
      const expression = unwrapExpression(value);
      if (expression && ts.isPropertyAccessExpression(expression)) return expression.name.text;
      if (expression && ts.isElementAccessExpression(expression)) {
        const argument = unwrapExpression(expression.argumentExpression);
        if (argument && ts.isStringLiteralLike(argument)) return argument.text;
      }
      return undefined;
    }
    function ambientProcess(value, seen = new Set()) {
      const expression = unwrapExpression(value);
      if (!expression) return false;
      if (ts.isIdentifier(expression)) {
        const binding = resolveBinding(expression);
        if (binding === null) return expression.text === "process";
        if (binding.module === "node:process") return true;
        if (!binding.initializer || seen.has(binding)) return false;
        seen.add(binding);
        return ambientProcess(binding.initializer, seen);
      }
      if ((ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) &&
          memberName(expression) === "process") {
        const receiver = unwrapExpression(expression.expression);
        return receiver && ts.isIdentifier(receiver) && receiver.text === "globalThis" &&
          resolveBinding(receiver) === null;
      }
      return false;
    }
    function abruptCallable(value, seen = new Set()) {
      const expression = unwrapExpression(value);
      if (!expression) return false;
      if (ts.isIdentifier(expression)) {
        const binding = resolveBinding(expression);
        if (binding?.module === "node:process" && abruptNames.has(binding.importedName)) return true;
        if (!binding?.initializer || seen.has(binding)) return false;
        seen.add(binding);
        return abruptCallable(binding.initializer, seen);
      }
      if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
        return abruptNames.has(memberName(expression)) && ambientProcess(expression.expression);
      }
      return false;
    }
    return abruptCallable(node.expression);
  }

  function containsPotentialAbruptCall(node) {
    let found = false;
    function visit(child) {
      if (found || ts.isFunctionLike(child) || ts.isClassLike(child)) return;
      if (isAbruptProcessCall(child)) { found = true; return; }
      ts.forEachChild(child, visit);
    }
    visit(node);
    return found;
  }

  let assertionCallSites = 0;
  let subjectAssertionCallSites = 0;
  let subjectAssertionExecutions = 0;

  function measureCounters(visitor) {
    const before = { assertionCallSites, subjectAssertionCallSites, subjectAssertionExecutions };
    visitor();
    const measured = {
      assertionCallSites: assertionCallSites - before.assertionCallSites,
      subjectAssertionCallSites: subjectAssertionCallSites - before.subjectAssertionCallSites,
      subjectAssertionExecutions: subjectAssertionExecutions - before.subjectAssertionExecutions,
    };
    ({ assertionCallSites, subjectAssertionCallSites, subjectAssertionExecutions } = before);
    return measured;
  }

  function visitExclusivePaths(visitors) {
    const paths = visitors.map((visitor) => measureCounters(visitor));
    assertionCallSites += paths.reduce((total, path) => total + path.assertionCallSites, 0);
    subjectAssertionCallSites += paths.reduce((total, path) => total + path.subjectAssertionCallSites, 0);
    subjectAssertionExecutions += Math.min(...paths.map((path) => path.subjectAssertionExecutions));
  }

  const NORMAL = "normal";
  function flow(...outcomes) { return new Set(outcomes); }
  function unionFlows(...flows) { return new Set(flows.flatMap((outcomes) => [...outcomes])); }
  function guaranteedNormal(outcomes) { return outcomes.size === 1 && outcomes.has(NORMAL); }
  function composeFlows(before, after) {
    const combined = new Set([...before].filter((outcome) => outcome !== NORMAL));
    if (before.has(NORMAL)) for (const outcome of after) combined.add(outcome);
    return combined;
  }

  function expressionAbruptFlow(node) {
    if (!containsPotentialAbruptCall(node)) return flow(NORMAL);
    return guaranteedMatchingCall(node, isAbruptProcessCall) ? flow("exit") : flow(NORMAL, "exit");
  }

  function visitSequence(statements, loopMultiplier, testContexts) {
    let outcomes = flow(NORMAL);
    for (const statement of statements) {
      const reachableOnEveryPath = guaranteedNormal(outcomes);
      const statementFlow = visitStatement(statement, reachableOnEveryPath ? loopMultiplier : 0, testContexts);
      if (outcomes.has(NORMAL)) outcomes = composeFlows(outcomes, statementFlow);
    }
    return outcomes;
  }

  function visitExpression(node, loopMultiplier, testContexts) {
    // Function declarations/callbacks are not evidence by themselves. Only callbacks passed to
    // a known node:test runner or a statically-sized forEach are traversed below.
    if (ts.isFunctionLike(node)) return;
    const method = assertMethod(node, testContexts);
    if (method) {
      assertionCallSites++;
      if (node.arguments.some((argument) => containsSubjectCall(argument, callbackModeForAssert(method)))) {
        subjectAssertionCallSites++;
        subjectAssertionExecutions += loopMultiplier;
      }
      return;
    }
    if (ts.isBinaryExpression(node) &&
        (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
         node.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
      visitExpression(node.left, loopMultiplier, testContexts);
      const left = staticBoolean(node.left);
      const isAnd = node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken;
      if ((isAnd && left === true) || (!isAnd && left === false)) {
        visitExpression(node.right, loopMultiplier, testContexts);
      } else if (left === undefined) {
        visitExclusivePaths([
          () => visitExpression(node.right, loopMultiplier, testContexts),
          () => {},
        ]);
      }
      return;
    }
    if (ts.isConditionalExpression(node)) {
      visitExpression(node.condition, loopMultiplier, testContexts);
      const condition = staticBoolean(node.condition);
      if (condition === true) visitExpression(node.whenTrue, loopMultiplier, testContexts);
      else if (condition === false) visitExpression(node.whenFalse, loopMultiplier, testContexts);
      else {
        visitExclusivePaths([
          () => visitExpression(node.whenTrue, loopMultiplier, testContexts),
          () => visitExpression(node.whenFalse, loopMultiplier, testContexts),
        ]);
      }
      return;
    }
    if (ts.isCallExpression(node)) {
      if (isKnownCallbackRunner(node) && !runnerIsDisabled(node)) {
        const providesTestContext = isTestContextRunner(node);
        for (const argument of node.arguments) callbackBody(argument, loopMultiplier, testContexts, providesTestContext);
      }
      const length = forEachLength(node);
      if (length !== undefined) {
        for (const argument of node.arguments) {
          if (!ts.isArrowFunction(argument) && !ts.isFunctionExpression(argument)) continue;
          const names = new Set();
          for (const parameter of argument.parameters) bindingNames(parameter.name, names);
          const multiplier = length === 0 ? 0
            : bindingFlowsIntoSubjectAssertion(argument.body, names, testContexts)
              ? loopMultiplier * length : loopMultiplier;
          callbackBody(argument, multiplier, testContexts, false, "forEach");
        }
      }
    }
    ts.forEachChild(node, (child) => visitExpression(child, loopMultiplier, testContexts));
  }

  function visitStatement(statement, loopMultiplier = 1, testContexts = new Set()) {
    if (ts.isExpressionStatement(statement)) {
      visitExpression(statement.expression, loopMultiplier, testContexts);
      return expressionAbruptFlow(statement.expression);
    }
    if (ts.isBlock(statement)) {
      return visitSequence(statement.statements, loopMultiplier, testContexts);
    }
    if (ts.isVariableStatement(statement)) {
      let outcomes = flow(NORMAL);
      for (const declaration of statement.declarationList.declarations) {
        if (!declaration.initializer) continue;
        visitExpression(declaration.initializer, guaranteedNormal(outcomes) ? loopMultiplier : 0, testContexts);
        outcomes = composeFlows(outcomes, expressionAbruptFlow(declaration.initializer));
      }
      return outcomes;
    }
    if (ts.isReturnStatement(statement)) {
      if (statement.expression) visitExpression(statement.expression, loopMultiplier, testContexts);
      return flow("return");
    }
    if (ts.isThrowStatement(statement)) {
      if (statement.expression) visitExpression(statement.expression, loopMultiplier, testContexts);
      return flow("throw");
    }
    if (ts.isBreakStatement(statement)) return flow("break");
    if (ts.isContinueStatement(statement)) return flow("continue");
    if (ts.isWhileStatement(statement)) {
      visitExpression(statement.expression, loopMultiplier, testContexts);
      const condition = staticBoolean(statement.expression);
      if (condition === false) {
        visitStatement(statement.statement, 0, testContexts);
        return flow(NORMAL);
      }
      const bodyFlow = visitStatement(statement.statement, condition === true ? loopMultiplier : 0, testContexts);
      const outcomes = new Set(condition === undefined ? [NORMAL] : []);
      for (const outcome of bodyFlow) {
        if (outcome === "break") outcomes.add(NORMAL);
        else if (outcome === "return" || outcome === "throw") outcomes.add(outcome);
        else if (condition === undefined) outcomes.add(NORMAL);
      }
      return outcomes;
    }
    if (ts.isDoStatement(statement)) {
      const bodyFlow = visitStatement(statement.statement, loopMultiplier, testContexts);
      visitExpression(statement.expression, guaranteedNormal(bodyFlow) ? loopMultiplier : 0, testContexts);
      const condition = staticBoolean(statement.expression);
      const outcomes = new Set();
      for (const outcome of bodyFlow) {
        if (outcome === "break") outcomes.add(NORMAL);
        else if (outcome === "return" || outcome === "throw") outcomes.add(outcome);
        else if (condition !== true) outcomes.add(NORMAL);
      }
      return outcomes;
    }
    if (ts.isForStatement(statement)) {
      if (statement.initializer) {
        if (ts.isVariableDeclarationList(statement.initializer)) {
          for (const declaration of statement.initializer.declarations) {
            if (declaration.initializer) visitExpression(declaration.initializer, loopMultiplier, testContexts);
          }
        } else visitExpression(statement.initializer, loopMultiplier, testContexts);
      }
      if (statement.condition) visitExpression(statement.condition, loopMultiplier, testContexts);
      const condition = statement.condition ? staticBoolean(statement.condition) : true;
      if (condition === false) {
        visitStatement(statement.statement, 0, testContexts);
        if (statement.incrementor) visitExpression(statement.incrementor, 0, testContexts);
        return flow(NORMAL);
      }
      const bodyFlow = visitStatement(statement.statement, condition === true ? loopMultiplier : 0, testContexts);
      if (statement.incrementor) visitExpression(statement.incrementor, guaranteedNormal(bodyFlow) ? loopMultiplier : 0, testContexts);
      const outcomes = new Set(condition === undefined ? [NORMAL] : []);
      for (const outcome of bodyFlow) {
        if (outcome === "break") outcomes.add(NORMAL);
        else if (outcome === "return" || outcome === "throw") outcomes.add(outcome);
        else if (condition === undefined) outcomes.add(NORMAL);
      }
      return outcomes;
    }
    if (ts.isForOfStatement(statement) || ts.isForInStatement(statement)) {
      const iterations = staticArrayLength(statement.expression);
      visitExpression(statement.expression, loopMultiplier, testContexts);
      let probedFlow;
      measureCounters(() => { probedFlow = visitStatement(statement.statement, 0, testContexts); });
      const names = ts.isVariableDeclarationList(statement.initializer) && statement.initializer.declarations[0]
        ? bindingNames(statement.initializer.declarations[0].name) : new Set();
      const multiplier = iterations === undefined || iterations === 0 ? 0
        : bindingFlowsIntoSubjectAssertion(statement.statement, names, testContexts) && guaranteedNormal(probedFlow)
          ? loopMultiplier * iterations : loopMultiplier;
      const bodyFlow = visitStatement(statement.statement, multiplier, testContexts);
      if (iterations === 0) return flow(NORMAL);
      const outcomes = new Set(iterations === undefined ? [NORMAL] : []);
      for (const outcome of bodyFlow) {
        if (outcome === "break" || outcome === NORMAL || outcome === "continue") outcomes.add(NORMAL);
        else if (outcome === "return" || outcome === "throw") outcomes.add(outcome);
      }
      return outcomes;
    }
    if (ts.isIfStatement(statement)) {
      visitExpression(statement.expression, loopMultiplier, testContexts);
      const condition = staticBoolean(statement.expression);
      if (condition === true) return visitStatement(statement.thenStatement, loopMultiplier, testContexts);
      else if (condition === false) {
        return statement.elseStatement
          ? visitStatement(statement.elseStatement, loopMultiplier, testContexts) : flow(NORMAL);
      } else {
        let thenFlow;
        let elseFlow;
        visitExclusivePaths([
          () => { thenFlow = visitStatement(statement.thenStatement, loopMultiplier, testContexts); },
          () => {
            elseFlow = statement.elseStatement
              ? visitStatement(statement.elseStatement, loopMultiplier, testContexts) : flow(NORMAL);
          },
        ]);
        return unionFlows(thenFlow, elseFlow);
      }
    }
    if (ts.isSwitchStatement(statement)) {
      visitExpression(statement.expression, loopMultiplier, testContexts);
      const clauses = statement.caseBlock.clauses;
      const switchValue = staticPrimitive(statement.expression);
      const visitPath = (start, multiplier = loopMultiplier) => {
        let outcomes = flow(NORMAL);
        for (let index = start; index < clauses.length; index++) {
          const clauseFlow = visitSequence(
            clauses[index].statements,
            guaranteedNormal(outcomes) ? multiplier : 0,
            testContexts
          );
          if (outcomes.has(NORMAL)) outcomes = composeFlows(outcomes, clauseFlow);
        }
        const consumed = new Set([...outcomes].filter((outcome) => outcome !== "break"));
        if (outcomes.has("break")) consumed.add(NORMAL);
        return consumed;
      };
      if (switchValue !== undefined) {
        let start = clauses.findIndex((clause) =>
          ts.isCaseClause(clause) && staticPrimitive(clause.expression) === switchValue);
        if (start < 0) start = clauses.findIndex(ts.isDefaultClause);
        return start >= 0 ? visitPath(start) : flow(NORMAL);
      } else {
        // Count syntax once at zero, then take the execution lower bound across every entry.
        for (const clause of clauses) {
          visitSequence(clause.statements, 0, testContexts);
        }
        const pathFlows = [];
        const pathExecutions = clauses.map((_, index) => {
          let pathFlow;
          const measured = measureCounters(() => { pathFlow = visitPath(index); });
          pathFlows.push(pathFlow);
          return measured.subjectAssertionExecutions;
        });
        if (!clauses.some(ts.isDefaultClause)) {
          pathExecutions.push(0);
          pathFlows.push(flow(NORMAL));
        }
        subjectAssertionExecutions += Math.min(...pathExecutions);
        return unionFlows(...pathFlows);
      }
    }
    if (ts.isTryStatement(statement)) {
      let tryFlow;
      let catchFlow;
      if (statement.catchClause) {
        visitExclusivePaths([
          () => { tryFlow = visitStatement(statement.tryBlock, loopMultiplier, testContexts); },
          () => { catchFlow = visitStatement(statement.catchClause.block, loopMultiplier, testContexts); },
        ]);
      } else {
        tryFlow = visitStatement(statement.tryBlock, loopMultiplier, testContexts);
      }
      let outcomes = catchFlow ? unionFlows(
        new Set([...tryFlow].filter((outcome) => outcome !== "throw")), catchFlow
      ) : tryFlow;
      if (statement.finallyBlock) {
        const finallyFlow = visitStatement(statement.finallyBlock, loopMultiplier, testContexts);
        if (!guaranteedNormal(finallyFlow)) outcomes = unionFlows(outcomes, finallyFlow);
      }
      return outcomes;
    }
    if (ts.isLabeledStatement(statement)) return visitStatement(statement.statement, loopMultiplier, testContexts);
    // Imports, declarations, classes, and unknown constructs are syntactic only. Never recurse
    // into an unsupported construct and promote a nested assertion to executed evidence.
    return flow(NORMAL);
  }

  visitSequence(source.statements, 1, new Set());
  return {
    assertionCallSites,
    subjectAssertionCallSites,
    subjectAssertionExecutions,
    minimum,
    pass: subjectAssertionCallSites >= 1 && subjectAssertionExecutions >= minimum,
  };
}

function main() {
  const [file, subject, rawMinimum] = process.argv.slice(2);
  const minimum = Number(rawMinimum);
  if (!file || !subject || !Number.isInteger(minimum) || minimum < 1) {
    console.error("usage: check-test-assertions.mjs <file> <subject> <minimum>");
    process.exit(2);
  }
  const result = analyzeAssertions(readFileSync(file, "utf8"), subject, minimum, file);
  if (!result.pass) {
    console.error(JSON.stringify(result));
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
