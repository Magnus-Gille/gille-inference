#!/usr/bin/env node
// AST-backed cross-file checker: accept equivalent TypeScript formatting/styles while requiring
// a real callable export and a real imported call (not a comment, unused import, or inline copy).
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import ts from "typescript";

function sourceFile(file) {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
}

function hasModifier(node, kind) {
  return node.modifiers?.some((modifier) => modifier.kind === kind) ?? false;
}

function isCallableInitializer(node) {
  return node !== undefined && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));
}

function isTargetModule(specifier, modulePrefix) {
  return specifier === modulePrefix || specifier === `${modulePrefix}.ts` ||
    specifier === `${modulePrefix}.js` || specifier === `${modulePrefix}.mjs`;
}

function createBindingResolver(source) {
  const scopeBindings = new WeakMap();
  const scopeParents = new WeakMap();
  const nodeScopes = new WeakMap();
  const declarationBindings = new WeakMap();

  const bindingMap = (scope) => {
    let map = scopeBindings.get(scope);
    if (!map) { map = new Map(); scopeBindings.set(scope, map); }
    return map;
  };
  const declareIdentifier = (scope, identifier, kind) => {
    const binding = { identifier, scope, kind };
    const map = bindingMap(scope);
    const entries = map.get(identifier.text) ?? [];
    entries.push(binding);
    map.set(identifier.text, entries);
    declarationBindings.set(identifier, binding);
    return binding;
  };
  const declareName = (scope, name, kind) => {
    if (ts.isIdentifier(name)) declareIdentifier(scope, name, kind);
    else for (const element of name.elements) {
      if (ts.isBindingElement(element)) declareName(scope, element.name, kind);
    }
  };
  const createsScope = (node) => ts.isFunctionLike(node) || ts.isBlock(node) || ts.isCatchClause(node) ||
    ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node);

  function collect(node, currentScope = source) {
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
      declareIdentifier(currentScope, node.name, ts.isFunctionDeclaration(node) ? "function" : "class");
    }
    let activeScope = currentScope;
    if (node !== source && createsScope(node)) {
      activeScope = node;
      scopeParents.set(activeScope, currentScope);
      bindingMap(activeScope);
    }
    nodeScopes.set(node, activeScope);
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
      const clause = node.importClause;
      if (clause?.name) declareIdentifier(activeScope, clause.name, "import");
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        declareIdentifier(activeScope, clause.namedBindings.name, "import");
      }
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          if (!element.isTypeOnly) declareIdentifier(activeScope, element.name, "import");
        }
      }
    }
    if (ts.isVariableDeclaration(node)) declareName(activeScope, node.name, "variable");
    if (ts.isParameter(node)) declareName(activeScope, node.name, "parameter");
    if (ts.isFunctionExpression(node) && node.name) declareIdentifier(activeScope, node.name, "function");
    ts.forEachChild(node, (child) => collect(child, activeScope));
  }
  bindingMap(source);
  collect(source);

  const resolve = (identifier) => {
    const declared = declarationBindings.get(identifier);
    if (declared) return declared;
    let scope = nodeScopes.get(identifier) ?? source;
    while (scope) {
      const entries = bindingMap(scope).get(identifier.text);
      if (entries) return entries.length === 1 ? entries[0] : null;
      scope = scopeParents.get(scope);
    }
    return null;
  };
  return { resolve };
}

function staticBoolean(node) {
  let current = node;
  while (current && (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) || ts.isSatisfiesExpression(current))) {
    current = current.expression;
  }
  if (current?.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (current?.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (current && ts.isPrefixUnaryExpression(current) && current.operator === ts.SyntaxKind.ExclamationToken) {
    const operand = staticBoolean(current.operand);
    return operand === undefined ? undefined : !operand;
  }
  if (current && ts.isBinaryExpression(current) &&
      (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
       current.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
    const left = staticBoolean(current.left);
    const right = staticBoolean(current.right);
    if (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      if (left === false || right === false) return false;
      if (left === true && right === true) return true;
    } else {
      if (left === true || right === true) return true;
      if (left === false && right === false) return false;
    }
  }
  if (current && ts.isConditionalExpression(current)) {
    const condition = staticBoolean(current.condition);
    if (condition === true) return staticBoolean(current.whenTrue);
    if (condition === false) return staticBoolean(current.whenFalse);
    const yes = staticBoolean(current.whenTrue);
    const no = staticBoolean(current.whenFalse);
    return yes !== undefined && yes === no ? yes : undefined;
  }
  return undefined;
}

function callableExports(source) {
  const callableLocals = new Map();
  const exportedLocals = new Map();
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      callableLocals.set(statement.name.text, statement);
      if (hasModifier(statement, ts.SyntaxKind.ExportKeyword)) exportedLocals.set(statement.name.text, statement.name.text);
    }
    if (ts.isVariableStatement(statement)) {
      const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !isCallableInitializer(declaration.initializer)) continue;
        callableLocals.set(declaration.name.text, declaration.initializer);
        if (exported) exportedLocals.set(declaration.name.text, declaration.name.text);
      }
    }
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        exportedLocals.set(element.name.text, element.propertyName?.text ?? element.name.text);
      }
    }
  }
  return new Map([...exportedLocals].flatMap(([exported, local]) => {
    const callable = callableLocals.get(local);
    return callable === undefined ? [] : [[exported, callable]];
  }));
}

function localCallables(source, resolver) {
  const callables = new Map();
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
      const binding = resolver.resolve(statement.name);
      if (binding) callables.set(binding, statement);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && isCallableInitializer(declaration.initializer)) {
          const binding = resolver.resolve(declaration.name);
          if (binding) callables.set(binding, declaration.initializer);
        }
      }
    }
  }
  return callables;
}

function importedBindings(source, symbol, modulePrefix, resolver) {
  const identifiers = new Set();
  const namespaces = new Set();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) ||
        !isTargetModule(statement.moduleSpecifier.text, modulePrefix)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if ((element.propertyName?.text ?? element.name.text) === symbol) {
          const binding = resolver.resolve(element.name);
          if (binding) identifiers.add(binding);
        }
      }
    } else if (bindings && ts.isNamespaceImport(bindings)) {
      const binding = resolver.resolve(bindings.name);
      if (binding) namespaces.add(binding);
    }
  }
  return { identifiers, namespaces };
}

function isImportedCall(node, symbol, bindings, resolver) {
  if (!ts.isCallExpression(node)) return false;
  if (ts.isIdentifier(node.expression)) return bindings.identifiers.has(resolver.resolve(node.expression));
  return ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) && bindings.namespaces.has(resolver.resolve(node.expression.expression)) &&
    node.expression.name.text === symbol;
}

function cloneFlowState(state) {
  return {
    env: new Map(state.env),
    validated: new Set(state.validated),
    consumerInputMutated: state.consumerInputMutated,
    terminal: null,
  };
}

function staticPrimitive(node) {
  let current = node;
  while (current && (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) || ts.isSatisfiesExpression(current))) current = current.expression;
  if (current && (ts.isStringLiteralLike(current) || ts.isNumericLiteral(current))) return current.text;
  if (current?.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (current?.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (current?.kind === ts.SyntaxKind.NullKeyword) return null;
  return undefined;
}

function staticIterableCardinality(node) {
  let current = node;
  while (current && (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) || ts.isSatisfiesExpression(current))) current = current.expression;
  if (current && ts.isArrayLiteralExpression(current) &&
      current.elements.every((element) => !ts.isSpreadElement(element))) return current.elements.length;
  return undefined;
}

function intersectSets(sets) {
  if (sets.length === 0) return new Set();
  return new Set([...sets[0]].filter((value) => sets.every((set) => set.has(value))));
}

function flowValue(tokens = [], importedResult = false, importedCallable = false, container = null) {
  return { tokens: new Set(tokens), importedResult, importedCallable, container };
}

function mergeFlowValues(values) {
  return {
    tokens: new Set(values.flatMap((value) => [...value.tokens])),
    importedResult: values.some((value) => value.importedResult),
    importedCallable: values.some((value) => value.importedCallable),
    container: null,
  };
}

function mergeAlternativeFlowValues(values) {
  if (values.length === 0) return flowValue();
  return {
    tokens: new Set(values.flatMap((value) => [...value.tokens])),
    importedResult: values.every((value) => value.importedResult),
    importedCallable: values.every((value) => value.importedCallable),
    container: null,
  };
}

/**
 * Bounded, intra-file abstract execution for the two holdout integration contracts. It follows
 * only actually-called local helpers, carries symbolic values through variables/parameters, and
 * keeps branch validation path-sensitive. This is deliberately not a TypeScript evaluator.
 */
function importedFlowOutcomes(file, symbol, modulePrefix, consumer, scenario = { csvSelected: true }) {
  const source = sourceFile(file);
  const root = callableExports(source).get(consumer);
  if (root === undefined) return [];
  const resolver = createBindingResolver(source);
  const callables = localCallables(source, resolver);
  const bindings = importedBindings(source, symbol, modulePrefix, resolver);
  const globalEnv = new Map();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer && !isCallableInitializer(declaration.initializer)) {
        const binding = resolver.resolve(declaration.name);
        if (binding) globalEnv.set(binding, flowValue([`global:${declaration.name.text}`]));
      }
    }
  }

  function unwrap(node) {
    let current = node;
    while (current && (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) ||
        ts.isTypeAssertionExpression(current) || ts.isSatisfiesExpression(current))) current = current.expression;
    return current;
  }

  function referenceFlow(node, state) {
    const value = unwrap(node);
    if (!value) return flowValue();
    if (ts.isIdentifier(value)) {
      const binding = resolver.resolve(value);
      return state.env.get(binding) ?? globalEnv.get(binding) ?? flowValue([`id:${value.text}`]);
    }
    if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
      return referenceFlow(value.expression, state);
    }
    return flowValue();
  }

  const isConsumerInput = (value) => [...value.tokens].some((token) => token.includes("consumer-param:"));
  const isCsvLiteral = (node) => {
    const value = unwrap(node);
    return value && ts.isStringLiteralLike(value) && value.text.replace(/^--/, "").toLowerCase() === "csv";
  };

  function csvComparison(node, state) {
    const value = unwrap(node);
    if (!value) return undefined;
    if (ts.isIdentifier(value)) {
      return isConsumerInput(referenceFlow(value, state)) ? scenario.csvSelected : undefined;
    }
    if (ts.isElementAccessExpression(value) && isConsumerInput(referenceFlow(value.expression, state))) {
      const index = staticPrimitive(value.argumentExpression);
      if (index !== undefined && /^\d+$/.test(String(index))) return String(index) === "1" && scenario.csvSelected;
      return scenario.csvSelected; // loop/dynamic lookup may select the CSV flag occurrence
    }
    return undefined;
  }

  function flowBoolean(node, state) {
    const value = unwrap(node);
    const syntactic = staticBoolean(value);
    if (syntactic !== undefined) return syntactic;
    if (!value) return undefined;
    if (state.consumerInputMutated) return undefined;
    if (ts.isCallExpression(value) && ts.isPropertyAccessExpression(value.expression) &&
        value.expression.name.text === "includes" && value.arguments.some(isCsvLiteral) &&
        ts.isIdentifier(unwrap(value.expression.expression)) &&
        isConsumerInput(referenceFlow(value.expression.expression, state))) {
      return scenario.csvSelected;
    }
    if (ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.ExclamationToken) {
      const operand = flowBoolean(value.operand, state);
      return operand === undefined ? undefined : !operand;
    }
    if (ts.isBinaryExpression(value)) {
      const operator = value.operatorToken.kind;
      const leftCsv = isCsvLiteral(value.left);
      const rightCsv = isCsvLiteral(value.right);
      const other = leftCsv ? value.right : rightCsv ? value.left : undefined;
      const csvMatch = other ? csvComparison(other, state) : undefined;
      if (csvMatch !== undefined) {
        if ([ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken].includes(operator)) {
          return csvMatch;
        }
        if ([ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(operator)) {
          return !csvMatch;
        }
      }
      const right = unwrap(value.right);
      if ([ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken].includes(operator) &&
          right && ts.isPropertyAccessExpression(right) && right.name.text === "length" &&
          isConsumerInput(referenceFlow(right.expression, state))) {
        const left = unwrap(value.left);
        const leftFlow = referenceFlow(left, state);
        const startsAtZero = staticPrimitive(left) === "0" ||
          (left && ts.isIdentifier(left) && leftFlow.tokens.size === 1 && leftFlow.tokens.has("literal:0"));
        if (startsAtZero) return scenario.csvSelected;
      }
      if (operator === ts.SyntaxKind.AmpersandAmpersandToken || operator === ts.SyntaxKind.BarBarToken) {
        const left = flowBoolean(value.left, state);
        const right = flowBoolean(value.right, state);
        if (operator === ts.SyntaxKind.AmpersandAmpersandToken) {
          if (left === false || right === false) return false;
          if (left === true && right === true) return true;
        } else {
          if (left === true || right === true) return true;
          if (left === false && right === false) return false;
        }
      }
    }
    if (ts.isConditionalExpression(value)) {
      const condition = flowBoolean(value.condition, state);
      if (condition === true) return flowBoolean(value.whenTrue, state);
      if (condition === false) return flowBoolean(value.whenFalse, state);
    }
    return undefined;
  }

  function flowPrimitive(node, state) {
    const primitive = staticPrimitive(node);
    if (primitive !== undefined) return primitive;
    return scenario.csvSelected && ts.isIdentifier(unwrap(node)) && isConsumerInput(referenceFlow(node, state))
      ? "csv" : undefined;
  }

  function invalidateContainer(value) {
    if (value?.container) value.container.invalidated = true;
  }

  function containerValues(container) {
    if (!container || container.invalidated) return [];
    return container.kind === "array" ? container.values : [...container.values.values()];
  }

  function expressionValue(node, state, stack, depth) {
    const value = node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)) ? node.expression : node;
    if (!value) return flowValue();
    if (ts.isIdentifier(value)) {
      const binding = resolver.resolve(value);
      if (bindings.identifiers.has(binding)) return flowValue([], false, true);
      return state.env.get(binding) ?? globalEnv.get(binding) ?? flowValue([`id:${value.text}`]);
    }
    if (ts.isFunctionLike(value) || ts.isClassExpression(value)) {
      return flowValue([`opaque-function:${value.pos}`]);
    }
    if (ts.isStringLiteralLike(value) || ts.isNumericLiteral(value) ||
        value.kind === ts.SyntaxKind.TrueKeyword || value.kind === ts.SyntaxKind.FalseKeyword ||
        value.kind === ts.SyntaxKind.NullKeyword) {
      return flowValue([`literal:${value.getText(source)}`]);
    }
    if (ts.isArrayLiteralExpression(value)) {
      const values = value.elements.map((element) => ts.isOmittedExpression(element)
        ? flowValue(["literal:undefined"])
        : expressionValue(element, state, stack, depth));
      return flowValue(
        values.flatMap((item) => [...item.tokens]),
        false,
        false,
        { kind: "array", values, invalidated: false }
      );
    }
    if (ts.isObjectLiteralExpression(value)) {
      const values = new Map();
      for (const property of value.properties) {
        if (ts.isSpreadAssignment(property)) {
          const spread = expressionValue(property.expression, state, stack, depth);
          invalidateContainer(spread);
          values.set(`spread:${property.pos}`, flowValue([`opaque-spread:${property.pos}`]));
        } else if (ts.isPropertyAssignment(property)) {
          const name = ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) || ts.isNumericLiteral(property.name)
            ? property.name.text : `computed:${property.name.pos}`;
          values.set(name, expressionValue(property.initializer, state, stack, depth));
        } else if (ts.isShorthandPropertyAssignment(property)) {
          values.set(property.name.text, expressionValue(property.name, state, stack, depth));
        } else if (ts.isMethodDeclaration(property)) {
          const name = ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)
            ? property.name.text : `method:${property.pos}`;
          values.set(name, flowValue([`opaque-function:${property.pos}`]));
        }
      }
      const members = [...values.values()];
      return flowValue(
        members.flatMap((item) => [...item.tokens]),
        false,
        false,
        { kind: "object", values, invalidated: false }
      );
    }
    if (ts.isConditionalExpression(value)) {
      const condition = flowBoolean(value.condition, state);
      if (condition === true) return expressionValue(value.whenTrue, state, stack, depth);
      if (condition === false) return expressionValue(value.whenFalse, state, stack, depth);
      const before = new Set(state.validated);
      const yes = cloneFlowState(state);
      const no = cloneFlowState(state);
      const yesValue = expressionValue(value.whenTrue, yes, stack, depth);
      const noValue = expressionValue(value.whenFalse, no, stack, depth);
      state.validated = intersectSets([before, yes.validated, no.validated]);
      state.consumerInputMutated = state.consumerInputMutated ||
        yes.consumerInputMutated || no.consumerInputMutated;
      return mergeAlternativeFlowValues([yesValue, noValue]);
    }
    if (ts.isBinaryExpression(value)) {
      if (value.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          value.operatorToken.kind <= ts.SyntaxKind.LastAssignment && ts.isIdentifier(value.left)) {
        const right = expressionValue(value.right, state, stack, depth);
        const assigned = value.operatorToken.kind === ts.SyntaxKind.EqualsToken
          ? right : flowValue([`opaque-assignment:${value.pos}`]);
        const binding = resolver.resolve(value.left);
        if (binding) state.env.set(binding, assigned);
        return assigned;
      }
      if (value.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          value.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
          (ts.isPropertyAccessExpression(value.left) || ts.isElementAccessExpression(value.left))) {
        const assigned = expressionValue(value.right, state, stack, depth);
        const base = expressionValue(value.left.expression, state, stack, depth);
        if (isConsumerInput(base)) state.consumerInputMutated = true;
        invalidateContainer(base);
        return assigned;
      }
      if (value.operatorToken.kind === ts.SyntaxKind.CommaToken) {
        expressionValue(value.left, state, stack, depth);
        return expressionValue(value.right, state, stack, depth);
      }
      if (value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          value.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
        const left = expressionValue(value.left, state, stack, depth);
        const truth = flowBoolean(value.left, state);
        const isAnd = value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken;
        if ((isAnd && truth === false) || (!isAnd && truth === true)) return left;
        if ((isAnd && truth === true) || (!isAnd && truth === false)) {
          return expressionValue(value.right, state, stack, depth);
        }
        const before = new Set(state.validated);
        const rightState = cloneFlowState(state);
        const right = expressionValue(value.right, rightState, stack, depth);
        state.validated = intersectSets([before, rightState.validated]);
        state.consumerInputMutated = state.consumerInputMutated || rightState.consumerInputMutated;
        return mergeAlternativeFlowValues([left, right]);
      }
      const left = expressionValue(value.left, state, stack, depth);
      const right = expressionValue(value.right, state, stack, depth);
      return flowValue(
        [...left.tokens, ...right.tokens],
        left.importedResult || right.importedResult,
        false
      );
    }
    if (ts.isCallExpression(value)) {
      const args = value.arguments.map((argument) => expressionValue(argument, state, stack, depth));
      if (isImportedCall(value, symbol, bindings, resolver)) {
        for (const token of args[0]?.tokens ?? []) state.validated.add(token);
        return flowValue([`import-result:${symbol}`], true);
      }
      const calledBinding = ts.isIdentifier(value.expression) ? resolver.resolve(value.expression) : null;
      if (calledBinding && callables.has(calledBinding) && depth < 8 && !stack.has(calledBinding)) {
        if (args.some(isConsumerInput)) state.consumerInputMutated = true;
        const called = runCallable(callables.get(calledBinding), args, new Set([...stack, calledBinding]), depth + 1);
        const completed = called.filter((outcome) => outcome.kind !== "throw");
        const guaranteed = intersectSets(completed.map((outcome) => outcome.validated));
        for (const token of guaranteed) state.validated.add(token);
        return mergeAlternativeFlowValues(called.filter((outcome) => outcome.kind === "return").map((outcome) => outcome.value));
      }
      if (ts.isPropertyAccessExpression(value.expression)) {
        const base = expressionValue(value.expression.expression, state, stack, depth);
        const selected = base.container?.kind === "object" && !base.container.invalidated
          ? base.container.values.get(value.expression.name.text) : undefined;
        if (selected?.importedCallable) {
          for (const token of args[0]?.tokens ?? []) state.validated.add(token);
          return flowValue([`import-result:${symbol}`], true);
        }
        const tokens = [...base.tokens].map((token) => `${value.expression.name.text}(${token})`);
        const safeTransforms = new Set([
          "trim", "trimStart", "trimEnd", "toLowerCase", "toUpperCase", "toString",
        ]);
        if (safeTransforms.has(value.expression.name.text)) {
          return flowValue(
            tokens.length > 0 ? tokens : [`call:${value.expression.name.text}`],
            base.importedResult,
            false
          );
        }
        if (value.expression.name.text === "join") {
          const members = containerValues(base.container);
          return flowValue(
            tokens.length > 0 ? tokens : [`call:join`],
            members.length > 0 ? members.some((member) => member.importedResult) : base.importedResult,
            false
          );
        }
        if (value.expression.name.text === "concat") {
          return flowValue(
            [...tokens, ...args.flatMap((argument) => [...argument.tokens])],
            base.importedResult || args.some((argument) => argument.importedResult),
            false
          );
        }
        if (isConsumerInput(base) && value.expression.name.text !== "includes") {
          state.consumerInputMutated = true;
        }
        if (args.some(isConsumerInput)) state.consumerInputMutated = true;
        invalidateContainer(base);
        for (const argument of args) invalidateContainer(argument);
        return flowValue([`opaque-call:${value.pos}`]);
      }
      const callee = expressionValue(value.expression, state, stack, depth);
      if (callee.importedCallable) {
        for (const token of args[0]?.tokens ?? []) state.validated.add(token);
        return flowValue([`import-result:${symbol}`], true);
      }
      // Unknown calls execute their arguments for side effects, but their result is fresh/opaque.
      if (args.some(isConsumerInput)) state.consumerInputMutated = true;
      invalidateContainer(callee);
      for (const argument of args) invalidateContainer(argument);
      return flowValue([`opaque-call:${value.pos}`]);
    }
    if (ts.isElementAccessExpression(value)) {
      const base = expressionValue(value.expression, state, stack, depth);
      if (value.argumentExpression) expressionValue(value.argumentExpression, state, stack, depth);
      const container = base.container;
      if (!container || container.invalidated) return flowValue([`opaque-element:${value.pos}`]);
      const key = staticPrimitive(value.argumentExpression);
      if (container.kind === "array" && key !== undefined && /^\d+$/.test(String(key))) {
        return container.values[Number(key)] ?? flowValue([`literal:undefined`]);
      }
      if (container.kind === "object" && key !== undefined) {
        return container.values.get(String(key)) ?? flowValue([`literal:undefined`]);
      }
      return mergeAlternativeFlowValues(containerValues(container));
    }
    if (ts.isDeleteExpression(value) &&
        (ts.isPropertyAccessExpression(unwrap(value.expression)) ||
         ts.isElementAccessExpression(unwrap(value.expression)))) {
      const target = unwrap(value.expression);
      const base = expressionValue(target.expression, state, stack, depth);
      if (isConsumerInput(base)) state.consumerInputMutated = true;
      invalidateContainer(base);
      return flowValue([`opaque-delete:${value.pos}`]);
    }
    if ((ts.isPrefixUnaryExpression(value) || ts.isPostfixUnaryExpression(value)) &&
        (ts.isPropertyAccessExpression(unwrap(value.operand)) ||
         ts.isElementAccessExpression(unwrap(value.operand)))) {
      const target = unwrap(value.operand);
      const base = expressionValue(target.expression, state, stack, depth);
      if (isConsumerInput(base)) state.consumerInputMutated = true;
      invalidateContainer(base);
      return flowValue([`opaque-update:${value.pos}`]);
    }
    if (ts.isPropertyAccessExpression(value)) {
      if (ts.isIdentifier(value.expression) && bindings.namespaces.has(resolver.resolve(value.expression)) &&
          value.name.text === symbol) return flowValue([], false, true);
      const base = expressionValue(value.expression, state, stack, depth);
      if (base.container?.kind === "object" && !base.container.invalidated) {
        return base.container.values.get(value.name.text) ?? flowValue([`literal:undefined`]);
      }
      if (base.container?.invalidated) return flowValue([`opaque-property:${value.pos}`]);
      return flowValue(
        [...base.tokens].map((token) => `${value.name.text}(${token})`),
        base.importedResult,
        base.importedCallable
      );
    }
    if (ts.isVoidExpression(value)) {
      expressionValue(value.expression, state, stack, depth);
      return flowValue(["literal:undefined"]);
    }
    if (ts.isPrefixUnaryExpression(value)) return expressionValue(value.operand, state, stack, depth);
    if (ts.isTemplateExpression(value)) {
      const spans = value.templateSpans.map((span) => expressionValue(span.expression, state, stack, depth));
      const merged = mergeFlowValues(spans);
      return flowValue([`template:${value.pos}(${[...merged.tokens].join(",")})`], merged.importedResult);
    }
    const children = [];
    ts.forEachChild(value, (child) => {
      if (!ts.isFunctionLike(child) && !ts.isClassLike(child)) {
        children.push(expressionValue(child, state, stack, depth));
      }
    });
    return mergeFlowValues(children);
  }

  function executeStatements(statements, initialStates, stack, depth) {
    const bindValue = (name, value, env) => {
      if (ts.isIdentifier(name)) {
        const binding = resolver.resolve(name);
        if (binding) env.set(binding, value);
      }
      else if (ts.isArrayBindingPattern(name)) {
        name.elements.forEach((element, index) => {
          if (!ts.isBindingElement(element)) return;
          const selected = value.container?.kind === "array" && !value.container.invalidated
            ? value.container.values[index] : flowValue([`opaque-binding:${element.pos}`]);
          bindValue(element.name, selected ?? flowValue(["literal:undefined"]), env);
        });
      } else {
        for (const element of name.elements) {
          if (!ts.isBindingElement(element)) continue;
          const property = element.propertyName ?? element.name;
          const key = ts.isIdentifier(property) || ts.isStringLiteralLike(property) || ts.isNumericLiteral(property)
            ? property.text : undefined;
          const selected = key !== undefined && value.container?.kind === "object" && !value.container.invalidated
            ? value.container.values.get(key) : flowValue([`opaque-binding:${element.pos}`]);
          bindValue(element.name, selected ?? flowValue(["literal:undefined"]), env);
        }
      }
    };
    const executeVariableDeclarations = (declarations, state) => {
      for (const declaration of declarations) {
        if (declaration.initializer) bindValue(
          declaration.name,
          expressionValue(declaration.initializer, state, stack, depth),
          state.env
        );
      }
    };
    const executeEmbedded = (statement, state) => ts.isBlock(statement)
      ? executeStatements(statement.statements, [state], stack, depth)
      : executeStatements([statement], [state], stack, depth);
    const loopExitStates = (states, mayTerminate) => states.flatMap((state) => {
      if (state.terminal?.kind === "break") {
        state.terminal = null;
        return [state];
      }
      if (state.terminal !== null && state.terminal.kind !== "continue") return [state];
      if (!mayTerminate) return [];
      if (state.terminal?.kind === "continue") state.terminal = null;
      return [state];
    });
    const applyFinally = (states, finallyBlock) => states.flatMap((state) => {
      const priorTerminal = state.terminal;
      const entering = cloneFlowState(state);
      const finalized = executeStatements(finallyBlock.statements, [entering], stack, depth);
      return finalized.map((finalState) => {
        if (finalState.terminal === null) finalState.terminal = priorTerminal;
        return finalState;
      });
    });
    let states = initialStates;
    for (const statement of statements) {
      const next = [];
      for (const state of states) {
        if (state.terminal !== null) { next.push(state); continue; }
        if (ts.isVariableStatement(statement)) {
          executeVariableDeclarations(statement.declarationList.declarations, state);
          next.push(state);
        } else if (ts.isExpressionStatement(statement)) {
          expressionValue(statement.expression, state, stack, depth);
          next.push(state);
        } else if (ts.isReturnStatement(statement)) {
          state.terminal = { kind: "return", value: expressionValue(statement.expression, state, stack, depth) };
          next.push(state);
        } else if (ts.isThrowStatement(statement)) {
          expressionValue(statement.expression, state, stack, depth);
          state.terminal = { kind: "throw" };
          next.push(state);
        } else if (ts.isBreakStatement(statement)) {
          state.terminal = { kind: "break" };
          next.push(state);
        } else if (ts.isContinueStatement(statement)) {
          state.terminal = { kind: "continue" };
          next.push(state);
        } else if (ts.isBlock(statement)) {
          next.push(...executeStatements(statement.statements, [state], stack, depth));
        } else if (ts.isIfStatement(statement)) {
          expressionValue(statement.expression, state, stack, depth);
          const condition = flowBoolean(statement.expression, state);
          const branches = condition === true ? [statement.thenStatement]
            : condition === false ? (statement.elseStatement ? [statement.elseStatement] : [])
              : [statement.thenStatement, ...(statement.elseStatement ? [statement.elseStatement] : [null])];
          for (const branch of branches) {
            const branchState = cloneFlowState(state);
            if (branch === null) next.push(branchState);
            else if (ts.isBlock(branch)) next.push(...executeStatements(branch.statements, [branchState], stack, depth));
            else next.push(...executeStatements([branch], [branchState], stack, depth));
          }
        } else if (ts.isWhileStatement(statement)) {
          expressionValue(statement.expression, state, stack, depth);
          const condition = flowBoolean(statement.expression, state);
          if (condition === false) {
            next.push(state);
          } else {
            const bodyStates = executeEmbedded(statement.statement, cloneFlowState(state));
            next.push(...loopExitStates(bodyStates, condition !== true));
            if (condition !== true) next.push(cloneFlowState(state));
          }
        } else if (ts.isDoStatement(statement)) {
          const rawBodyStates = executeEmbedded(statement.statement, cloneFlowState(state));
          for (const bodyState of rawBodyStates) {
            if (bodyState.terminal === null || bodyState.terminal?.kind === "continue") {
              expressionValue(statement.expression, bodyState, stack, depth);
            }
          }
          next.push(...loopExitStates(rawBodyStates, flowBoolean(statement.expression, state) !== true));
        } else if (ts.isForStatement(statement)) {
          if (statement.initializer) {
            if (ts.isVariableDeclarationList(statement.initializer)) {
              executeVariableDeclarations(statement.initializer.declarations, state);
            } else expressionValue(statement.initializer, state, stack, depth);
          }
          if (statement.condition) expressionValue(statement.condition, state, stack, depth);
          const condition = statement.condition === undefined ? true : flowBoolean(statement.condition, state);
          if (condition === false) {
            next.push(state);
          } else {
            const rawBodyStates = executeEmbedded(statement.statement, cloneFlowState(state));
            for (const bodyState of rawBodyStates) {
              if (bodyState.terminal === null && statement.incrementor) {
                expressionValue(statement.incrementor, bodyState, stack, depth);
              }
            }
            next.push(...loopExitStates(rawBodyStates, condition !== true));
            if (condition !== true) next.push(cloneFlowState(state));
          }
        } else if (ts.isForOfStatement(statement) || ts.isForInStatement(statement)) {
          const iterable = expressionValue(statement.expression, state, stack, depth);
          const cardinality = ts.isForOfStatement(statement)
            ? staticIterableCardinality(statement.expression) : undefined;
          if (cardinality === 0) {
            next.push(state);
            continue;
          }
          const bodyState = cloneFlowState(state);
          if (ts.isVariableDeclarationList(statement.initializer)) {
            const declaration = statement.initializer.declarations[0];
            if (declaration) bindValue(declaration.name, flowValue([...iterable.tokens].map((token) => `item(${token})`)), bodyState.env);
          } else if (ts.isIdentifier(statement.initializer)) {
            const binding = resolver.resolve(statement.initializer);
            if (binding) bodyState.env.set(binding, flowValue([...iterable.tokens].map((token) => `item(${token})`)));
          }
          const scenarioNonempty = scenario.csvSelected && !state.consumerInputMutated &&
            isConsumerInput(iterable);
          if (cardinality === undefined && !scenarioNonempty) next.push(cloneFlowState(state));
          next.push(...loopExitStates(executeEmbedded(statement.statement, bodyState), true));
        } else if (ts.isSwitchStatement(statement)) {
          expressionValue(statement.expression, state, stack, depth);
          const discriminant = flowPrimitive(statement.expression, state);
          const clauses = statement.caseBlock.clauses;
          const executeFrom = (index) => {
            let active = [cloneFlowState(state)];
            const completed = [];
            for (let i = index; i < clauses.length; i++) {
              const outcomes = executeStatements(clauses[i].statements, active, stack, depth);
              active = [];
              for (const outcome of outcomes) {
                if (outcome.terminal?.kind === "break") {
                  outcome.terminal = null;
                  completed.push(outcome);
                } else if (outcome.terminal !== null) {
                  completed.push(outcome);
                } else {
                  active.push(outcome); // fall through to the next clause
                }
              }
              if (active.length === 0) break;
            }
            return [...completed, ...active];
          };
          if (discriminant !== undefined) {
            const match = clauses.findIndex((clause) => ts.isCaseClause(clause) && staticPrimitive(clause.expression) === discriminant);
            const fallback = clauses.findIndex(ts.isDefaultClause);
            const index = match >= 0 ? match : fallback;
            if (index >= 0) next.push(...executeFrom(index));
            else next.push(state);
          } else {
            for (let index = 0; index < clauses.length; index++) next.push(...executeFrom(index));
            if (!clauses.some(ts.isDefaultClause)) next.push(cloneFlowState(state));
          }
        } else if (ts.isTryStatement(statement)) {
          let tryStates = executeStatements(statement.tryBlock.statements, [cloneFlowState(state)], stack, depth);
          if (statement.catchClause) {
            const caught = cloneFlowState(state);
            if (statement.catchClause.variableDeclaration) {
              bindValue(statement.catchClause.variableDeclaration.name, flowValue(["caught-error"]), caught.env);
            }
            tryStates.push(...executeStatements(statement.catchClause.block.statements, [caught], stack, depth));
          }
          next.push(...(statement.finallyBlock ? applyFinally(tryStates, statement.finallyBlock) : tryStates));
        } else if (ts.isLabeledStatement(statement)) {
          next.push(...executeEmbedded(statement.statement, state));
        } else if (ts.isEmptyStatement(statement)) {
          next.push(state);
        } else {
          // Unknown control-flow constructs are deliberately conservative: never walk their AST
          // and accidentally promote a syntactically nested dependency to executed evidence.
          next.push(state);
        }
      }
      states = next;
    }
    return states;
  }

  function runCallable(callable, args, stack, depth) {
    const state = {
      env: new Map(globalEnv),
      validated: new Set(),
      consumerInputMutated: false,
      terminal: null,
    };
    callable.parameters.forEach((parameter, index) => {
      if (ts.isIdentifier(parameter.name)) {
        const binding = resolver.resolve(parameter.name);
        if (binding) state.env.set(binding, args[index] ?? flowValue([`arg:${index}`]));
      }
    });
    let states;
    if (ts.isBlock(callable.body)) {
      states = executeStatements(callable.body.statements, [state], stack, depth);
    } else {
      state.terminal = { kind: "return", value: expressionValue(callable.body, state, stack, depth) };
      states = [state];
    }
    return states.map((finalState) => ({
      ...(finalState.terminal ?? { kind: "fallthrough" }),
      validated: finalState.validated,
    }));
  }

  const rootArgs = root.parameters.map((_parameter, index) => flowValue([`consumer-param:${index}`]));
  return runCallable(root, rootArgs, new Set(), 0);
}

export function hasImportedReturnFlow(file, symbol, modulePrefix, consumer) {
  const completed = importedFlowOutcomes(file, symbol, modulePrefix, consumer)
    .filter((outcome) => outcome.kind !== "throw");
  return completed.length > 0 && completed.every((outcome) =>
    outcome.kind === "return" && outcome.value.importedResult);
}

export function hasImportedValidatedReturn(file, symbol, modulePrefix, consumer) {
  const returns = importedFlowOutcomes(file, symbol, modulePrefix, consumer)
    .filter((outcome) => outcome.kind === "return");
  return returns.length > 0 && returns.every((outcome) =>
    outcome.value.tokens.size > 0 && [...outcome.value.tokens].every((token) => outcome.validated.has(token))
  );
}

export function hasCallableExport(file, symbol) {
  return callableExports(sourceFile(file)).has(symbol);
}

export function hasImportedCall(file, symbol, modulePrefix, consumer) {
  const source = sourceFile(file);
  const resolver = createBindingResolver(source);
  const bindings = importedBindings(source, symbol, modulePrefix, resolver);

  const root = consumer === undefined ? source : callableExports(source).get(consumer);
  if (root === undefined) return false;

  let found = false;
  function visit(node, isRoot = false) {
    if (node === undefined) return;
    // A nested helper/callback is not proof that the exported consumer executes the dependency.
    if (!isRoot && ts.isFunctionLike(node)) return;
    if (ts.isIfStatement(node)) {
      const condition = staticBoolean(node.expression);
      if (condition === false) {
        if (node.elseStatement) visit(node.elseStatement);
      } else if (condition === true) {
        visit(node.thenStatement);
      } else {
        visit(node.expression);
        visit(node.thenStatement);
        if (node.elseStatement) visit(node.elseStatement);
      }
      return;
    }
    if (ts.isConditionalExpression(node)) {
      const condition = staticBoolean(node.condition);
      if (condition === false) visit(node.whenFalse);
      else if (condition === true) visit(node.whenTrue);
      else { visit(node.condition); visit(node.whenTrue); visit(node.whenFalse); }
      return;
    }
    if (ts.isBinaryExpression(node) &&
        (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
         node.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
      visit(node.left);
      if (found) return;
      const left = staticBoolean(node.left);
      const isAnd = node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken;
      if ((isAnd && left !== false) || (!isAnd && left !== true)) visit(node.right);
      return;
    }
    if (ts.isWhileStatement(node)) {
      visit(node.expression);
      if (!found && staticBoolean(node.expression) !== false) visit(node.statement);
      return;
    }
    if (ts.isForStatement(node)) {
      if (node.initializer) visit(node.initializer);
      if (!found && node.condition) visit(node.condition);
      if (!found && staticBoolean(node.condition) !== false) visit(node.statement);
      return;
    }
    if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
      visit(node.expression);
      if (found) return;
      if (!ts.isForOfStatement(node) || staticIterableCardinality(node.expression) !== 0) visit(node.statement);
      return;
    }
    if (ts.isBlock(node)) {
      for (const statement of node.statements) {
        visit(statement);
        if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) break;
      }
      return;
    }
    if (ts.isCallExpression(node)) {
      if (isImportedCall(node, symbol, bindings, resolver)) found = true;
    }
    if (!found) ts.forEachChild(node, visit);
  }
  if (consumer === undefined) {
    visit(source, true);
  } else if (ts.isFunctionDeclaration(root)) {
    if (root.body) visit(root.body, true);
  } else {
    visit(root.body, true);
  }
  return found;
}

function main() {
  const [mode, file, symbol, modulePrefix, consumer] = process.argv.slice(2);
  const pass = mode === "export-callable"
    ? Boolean(file && symbol && hasCallableExport(file, symbol))
    : mode === "import-call"
      ? Boolean(file && symbol && modulePrefix && consumer && hasImportedCall(file, symbol, modulePrefix, consumer))
      : mode === "import-return-flow"
        ? Boolean(file && symbol && modulePrefix && consumer && hasImportedReturnFlow(file, symbol, modulePrefix, consumer))
        : mode === "import-validated-return"
          ? Boolean(file && symbol && modulePrefix && consumer && hasImportedValidatedReturn(file, symbol, modulePrefix, consumer))
      : null;
  if (pass === null) {
    console.error("usage: check-ts-contract.mjs export-callable <file> <symbol> | import-{call,return-flow,validated-return} <file> <symbol> <module-prefix> <exported-consumer>");
    process.exit(2);
  }
  if (!pass) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
