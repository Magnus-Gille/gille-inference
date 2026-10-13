import path from 'node:path';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

function globExpression(pattern) {
  const value = pattern.replace(/!$/, '');
  let expression = '^';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '*' && value[index + 1] === '*') {
      index += 1;
      if (value[index + 1] === '/') {
        index += 1;
        expression += '(?:.*/)?';
      } else expression += '.*';
    } else if (character === '*') expression += '[^/]*';
    else if (character === '?') expression += '[^/]';
    else expression += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(`${expression}$`);
}

function matchesAny(patterns, file) {
  return patterns.some(pattern => globExpression(pattern).test(file));
}

export function packageScriptPaths(packageJson) {
  const found = new Set();
  const pathPattern = /\b(?:src|scripts|client|tests|benchmarks|gate-d)\/[A-Za-z0-9_./-]+\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)\b/g;
  for (const command of Object.values(packageJson?.scripts ?? {})) {
    for (const match of String(command).matchAll(pathPattern)) found.add(match[0]);
  }
  return [...found].sort();
}

export function packageScriptPathsForEvidence(packageJson, entries) {
  return packageScriptPaths(packageJson).filter(file => entries.some(pattern => globExpression(pattern).test(file)));
}

export function validateUnusedScope({ scope, config, packageJson, files }) {
  const tracked = new Set(files);
  const entries = config?.entry ?? [];
  const project = config?.project ?? [];
  const missingOperatorRoots = (scope?.required_operator_roots ?? []).filter(file => !tracked.has(file));
  const missingOperatorEntries = (scope?.required_operator_roots ?? []).filter(file => !entries.includes(file + '!'));
  const operatorEvidence = scope?.operator_root_evidence ?? [];
  const evidenceRoots = new Set(operatorEvidence.map(item => item.root));
  const missingOperatorEvidenceRoots = (scope?.required_operator_roots ?? []).filter(file => !evidenceRoots.has(file));
  const invalidOperatorEvidence = operatorEvidence.filter(item => !tracked.has(item.source)
    || !Number.isSafeInteger(item.line) || item.line < 1 || typeof item.pattern !== 'string' || !item.pattern);
  const missingKnownConsumerEntries = [
    ...(scope?.known_test_consumers ?? []),
    ...(scope?.known_benchmark_consumers ?? []),
  ].filter(file => !entries.some(pattern => globExpression(pattern).test(file)));
  const missingPackageScriptPaths = packageScriptPaths(packageJson)
    .filter(file => !entries.some(pattern => globExpression(pattern).test(file)));
  const missingConsumerProjectGlobs = (scope?.knip_project_globs ?? [])
    .filter(pattern => !project.includes(pattern));
  const missingAuditedCandidatePrefixes = (scope?.candidate_source_prefixes ?? [])
    .filter(prefix => !(scope?.audited_source_prefixes ?? []).some(auditedPrefix => prefix.startsWith(auditedPrefix)));
  const missingCandidateProjectPaths = files.filter(file => {
    const candidate = (scope?.candidate_source_prefixes ?? []).some(prefix => file.startsWith(prefix));
    const source = SOURCE_EXTENSIONS.has(path.posix.extname(file));
    return candidate && source && !project.some(pattern => globExpression(pattern).test(file));
  });
  const consumerPatternsPresent = Object.fromEntries(Object.entries(scope?.consumer_entry_globs ?? {})
    .map(([name, patterns]) => [name, patterns.every(pattern => entries.includes(pattern))]));
  const missingConsumerEntryPatterns = Object.entries(consumerPatternsPresent)
    .filter(([, present]) => !present)
    .map(([name]) => name);
  return {
    schema_version: scope?.schema_version ?? null,
    scope_version: scope?.scope_version ?? null,
    missing_operator_roots: missingOperatorRoots,
    missing_operator_entries: missingOperatorEntries,
    missing_operator_evidence_roots: missingOperatorEvidenceRoots,
    invalid_operator_evidence: invalidOperatorEvidence,
    missing_known_consumer_entries: missingKnownConsumerEntries,
    missing_package_script_paths: missingPackageScriptPaths,
    missing_consumer_project_globs: missingConsumerProjectGlobs,
    missing_audited_candidate_prefixes: missingAuditedCandidatePrefixes,
    missing_candidate_project_paths: missingCandidateProjectPaths,
    missing_consumer_entry_patterns: missingConsumerEntryPatterns,
    consumer_patterns_present: consumerPatternsPresent,
    complete: scope?.schema_version === 2
      && typeof scope?.scope_version === 'string'
      && missingOperatorRoots.length === 0
      && missingOperatorEntries.length === 0
      && missingOperatorEvidenceRoots.length === 0
      && invalidOperatorEvidence.length === 0
      && missingKnownConsumerEntries.length === 0
      && missingPackageScriptPaths.length === 0
      && missingConsumerProjectGlobs.length === 0
      && missingAuditedCandidatePrefixes.length === 0
      && missingCandidateProjectPaths.length === 0
      && missingConsumerEntryPatterns.length === 0,
  };
}

function consumerClass(scope, file) {
  const special = scope.special_consumer_classes?.[file];
  if (special) return special;
  return scope.consumer_classes?.find(item => item.prefixes.some(prefix => file.startsWith(prefix)))?.class ?? null;
}

function lineAt(source, offset) {
  return source.slice(0, offset).split('\n').length;
}

function sourceTargets(files, fromFile) {
  const targets = files;
  return specifier => {
    if (specifier.startsWith('@/') || specifier.startsWith('~/')) return { target: null, unresolved: true };
    if (!specifier.startsWith('.')) return { target: null, unresolved: false };
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
    const ext = path.posix.extname(base);
    const candidates = ext === '.js'
      ? [base.slice(0, -3) + '.ts', base.slice(0, -3) + '.tsx', base]
      : ext === '.jsx'
        ? [base.slice(0, -4) + '.tsx', base]
        : ext
          ? [base]
          : [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}/index.ts`, `${base}/index.js`];
    const target = candidates.find(candidate => targets.has(candidate));
    return target ? { target, unresolved: false } : { target: null, unresolved: true };
  };
}

function importSymbols(ts, node) {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (!clause) return ['*'];
    const symbols = [];
    if (clause.name) symbols.push('default');
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) symbols.push('*');
    else if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) symbols.push((element.propertyName ?? element.name).text);
    }
    return symbols.length ? [...new Set(symbols)] : ['*'];
  }
  if (ts.isExportDeclaration(node)) {
    if (!node.exportClause || !ts.isNamedExports(node.exportClause)) return ['*'];
    return [...new Set(node.exportClause.elements.map(element => (element.propertyName ?? element.name).text))];
  }
  if (ts.isImportTypeNode(node)) {
    if (!node.qualifier) return ['*'];
    let name = node.qualifier;
    while (ts.isQualifiedName(name)) name = name.left;
    return [name.text];
  }
  return ['*'];
}

function isStringLiteralLike(ts, node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

function unwrapExpression(ts, node) {
  let expression = node;
  while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)
    || ts.isTypeAssertionExpression(expression) || ts.isNonNullExpression(expression)) {
    expression = expression.expression;
  }
  return expression;
}

function cwdResolvedLiteral(ts, expression) {
  const href = unwrapExpression(ts, expression);
  if (!ts.isPropertyAccessExpression(href) || href.name.text !== 'href') return null;
  const toUrl = unwrapExpression(ts, href.expression);
  if (!ts.isCallExpression(toUrl) || !ts.isIdentifier(toUrl.expression)
    || toUrl.expression.text !== 'pathToFileURL' || toUrl.arguments.length !== 1) return null;
  const resolve = unwrapExpression(ts, toUrl.arguments[0]);
  if (!ts.isCallExpression(resolve) || !ts.isIdentifier(resolve.expression)
    || resolve.expression.text !== 'resolve' || resolve.arguments.length !== 2) return null;
  const cwd = unwrapExpression(ts, resolve.arguments[0]);
  if (!ts.isCallExpression(cwd) || !ts.isPropertyAccessExpression(cwd.expression)
    || cwd.expression.name.text !== 'cwd' || !ts.isIdentifier(cwd.expression.expression)
    || cwd.expression.expression.text !== 'process' || !isStringLiteralLike(ts, resolve.arguments[1])) return null;
  return resolve.arguments[1].text;
}

function candidatePathPrefix(scope, targetPath) {
  if (!targetPath) return true;
  return (scope.candidate_source_prefixes ?? []).some(prefix => {
    const root = prefix.replace(/\/$/, '');
    return targetPath === root || targetPath.startsWith(prefix);
  });
}

function resolveLiteral(ts, scope, source, file, specifier, targets, referenceType, specifierNode) {
  const line = lineAt(source, specifierNode.getStart());
  if (specifier === 'module' || specifier === 'node:module') {
    return {
      reference: null,
      unresolved: false,
      unknown: {
        path: file,
        line,
        kind: 'unsupported-node-module-import',
        target: specifier,
        may_target_candidate: true,
      },
    };
  }
  if (specifier === 'child_process' || specifier === 'node:child_process') {
    return {
      reference: null,
      unresolved: false,
      unknown: {
        path: file,
        line,
        kind: 'unsupported-child-process-import',
        target: specifier,
        may_target_candidate: true,
      },
    };
  }
  if (specifier.startsWith('node:')) return { reference: null, unresolved: false };
  const normalized = referenceType === 'dynamic-cwd-literal'
    ? path.posix.normalize(specifier)
    : specifier.startsWith('.')
      ? path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))
      : null;
  const result = referenceType === 'dynamic-cwd-literal'
    ? (targets.has(specifier) ? { target: specifier, unresolved: false } : { target: null, unresolved: true })
    : sourceTargets(targets, file)(specifier);
  if (result.unresolved) {
    const unknown = {
      path: file,
      line,
      kind: specifier.startsWith('.') ? 'unresolved-source-specifier' : 'unresolved-path-alias',
      target: specifier,
      normalized_target: normalized,
      may_target_candidate: candidatePathPrefix(scope, normalized),
    };
    return { reference: null, unresolved: true, unknown };
  }
  if (!result.target) return { reference: null, unresolved: false };
  return {
    reference: {
      path: file,
      line,
      consumer_class: consumerClass(scope, file),
      target_path: result.target,
      reference_type: referenceType,
      imported_symbols: referenceType.startsWith('dynamic') ? ['*']
        : importSymbols(ts, referenceType === 'type-import' ? specifierNode.parent.parent : specifierNode.parent),
    },
    unresolved: false,
  };
}

function findSourceReferences(ts, scope, file, source, targets) {
  const references = [];
  const unresolvedLocalReferences = [];
  const dynamicUnknowns = [];
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true,
    /\.[cm]?jsx?$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  for (const diagnostic of sourceFile.parseDiagnostics ?? []) {
    dynamicUnknowns.push({
      path: file,
      line: lineAt(source, diagnostic.start ?? 0),
      kind: 'source-parse-diagnostic',
      reason: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
    });
  }

  const resolveNode = (specifierNode, referenceType) => {
    const resolved = resolveLiteral(ts, scope, source, file, specifierNode.text, targets, referenceType, specifierNode);
    if (resolved.reference) references.push(resolved.reference);
    if (resolved.unknown) {
      unresolvedLocalReferences.push(resolved.unknown);
      if (resolved.unknown.may_target_candidate) dynamicUnknowns.push(resolved.unknown);
    }
  };
  const visit = node => {
    if (ts.isIdentifier(node) && node.text === 'createRequire') {
      dynamicUnknowns.push({
        path: file,
        line: lineAt(source, node.getStart(sourceFile)),
        kind: 'unsupported-create-require',
        may_target_candidate: true,
      });
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      resolveNode(node.moduleSpecifier, 'static-import');
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      resolveNode(node.moduleSpecifier, 're-export');
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && isStringLiteralLike(ts, node.argument.literal)) {
      resolveNode(node.argument.literal, 'type-import');
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];
      const cwdPath = argument ? cwdResolvedLiteral(ts, argument) : null;
      if (cwdPath) {
        const result = resolveLiteral(ts, scope, source, file, cwdPath, targets, 'dynamic-cwd-literal', node.arguments[0]);
        if (result.reference) references.push(result.reference);
        if (result.unknown) {
          unresolvedLocalReferences.push(result.unknown);
          if (result.unknown.may_target_candidate) dynamicUnknowns.push(result.unknown);
        }
      } else if (argument && isStringLiteralLike(ts, unwrapExpression(ts, argument))) {
        resolveNode(unwrapExpression(ts, argument), 'dynamic-literal');
      } else {
        dynamicUnknowns.push({
          path: file,
          line: lineAt(source, node.getStart(sourceFile)),
          kind: 'computed-dynamic-import',
          may_target_candidate: true,
        });
      }
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
      if (node.arguments.length > 0 && isStringLiteralLike(ts, unwrapExpression(ts, node.arguments[0]))) {
        resolveNode(unwrapExpression(ts, node.arguments[0]), 'require-literal');
      } else {
        dynamicUnknowns.push({
          path: file,
          line: lineAt(source, node.getStart(sourceFile)),
          kind: 'computed-require',
          may_target_candidate: true,
        });
      }
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression && isStringLiteralLike(ts, node.moduleReference.expression)) {
      resolveNode(node.moduleReference.expression, 'require-literal');
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const dataEnumerations = [];
  for (const check of scope.reviewed_data_enumerations ?? []) {
    if (check.path !== file) continue;
    let lineOffset = 0;
    for (const line of source.split('\n')) {
      if (line.includes(check.pattern)) {
        dataEnumerations.push({ path: file, line: lineOffset + 1, kind: check.kind, reason: check.reason });
      }
      lineOffset += 1;
    }
  }
  return { references, unresolvedLocalReferences, dynamicUnknowns, dataEnumerations };
}

export async function buildUnusedReferenceAudit({ scope, files, completeInventory = true, readSource }) {
  if (!Array.isArray(files) || typeof readSource !== 'function') throw new TypeError('unused audit requires a tracked-file inventory and source reader');
  const { default: ts } = await import('typescript');
  const sourceFiles = [...new Set(files)].filter(file => {
    const extension = path.posix.extname(file);
    return SOURCE_EXTENSIONS.has(extension) && scope.audited_source_prefixes.some(prefix => file.startsWith(prefix));
  }).sort();
  const references = [];
  const unresolvedLocalReferences = [];
  const dynamicUnknowns = [];
  const dataEnumerations = [];
  const sourceLineCounts = {};
  const trackedFiles = new Set(files);
  const inventoryByClass = Object.fromEntries((scope.consumer_classes ?? []).map(item => [item.class, 0]));
  for (const file of sourceFiles) {
    const classification = consumerClass(scope, file);
    if (classification) inventoryByClass[classification] = (inventoryByClass[classification] ?? 0) + 1;
    const source = await readSource(file);
    sourceLineCounts[file] = source.split(/\r?\n/).length;
    const result = findSourceReferences(ts, scope, file, source, trackedFiles);
    references.push(...result.references);
    unresolvedLocalReferences.push(...result.unresolvedLocalReferences);
    dynamicUnknowns.push(...result.dynamicUnknowns);
    dataEnumerations.push(...result.dataEnumerations);
  }
  const uniqueUnknowns = [...new Map(dynamicUnknowns.map(item => [
    item.path + ':' + item.line + ':' + item.kind + ':' + (item.target ?? ''), item,
  ])).values()]
    .sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line || left.kind.localeCompare(right.kind));
  const uniqueReferences = [...new Map(references.map(item => [
    item.path + ':' + item.line + ':' + item.target_path + ':' + item.reference_type + ':' + JSON.stringify(item.imported_symbols), item,
  ])).values()]
    .sort((left, right) => left.target_path.localeCompare(right.target_path)
      || left.path.localeCompare(right.path) || left.line - right.line);
  const uniqueUnresolved = [...new Map(unresolvedLocalReferences.map(item => [
    item.path + ':' + item.line + ':' + item.target, item,
  ])).values()]
    .sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line || left.target.localeCompare(right.target));
  const uniqueDataEnumerations = [...new Map(dataEnumerations.map(item => [
    item.path + ':' + item.line + ':' + item.kind, item,
  ])).values()]
    .sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line);
  const classCounts = Object.fromEntries([...new Set(uniqueReferences.map(item => item.consumer_class))]
    .filter(Boolean).sort().map(name => [name, uniqueReferences.filter(item => item.consumer_class === name).length]));
  return {
    schema_version: 2,
    scope_version: scope.scope_version,
    complete_source_inventory: completeInventory,
    inventory: {
      total_source_files: sourceFiles.length,
      source_paths: sourceFiles,
      source_line_counts: sourceLineCounts,
      source_files_by_class: inventoryByClass,
    },
    reference_count: uniqueReferences.length,
    reference_count_by_class: classCounts,
    references: uniqueReferences,
    unresolved_local_reference_count: uniqueUnresolved.length,
    unresolved_local_references: uniqueUnresolved,
    dynamic_unknown_count: uniqueUnknowns.length,
    dynamic_unknowns: uniqueUnknowns,
    reviewed_data_enumeration_count: uniqueDataEnumerations.length,
    reviewed_data_enumerations: uniqueDataEnumerations,
    graph_qualified: completeInventory && uniqueUnknowns.length === 0,
    graph_qualification_reason: !completeInventory
      ? 'The tracked source inventory is not a clean immutable worktree.'
      : uniqueUnknowns.length === 0
        ? 'All declared roots and source-reference classes were inventoried; no unresolved candidate-module references remain.'
        : uniqueUnknowns.length + ' unresolved dynamic or candidate-module references remain; candidate rows stay unknown.',
  };
}

function pathMatchesAnyPrefix(file, prefixes) {
  return prefixes.some(prefix => file === prefix.replace(/\/$/, '') || file.startsWith(prefix));
}

function invalidCandidateEvidence(row, reason) {
  return {
    ...row,
    candidate_state: 'unknown-invalid-candidate-evidence',
    candidate_evidence_issue: reason,
    consumer_references: [],
  };
}

export function attachUnusedConsumerEvidence(rows, audit, scope) {
  const trackedSources = new Set(audit.inventory?.source_paths ?? []);
  const lineCounts = audit.inventory?.source_line_counts ?? {};
  const candidateKinds = new Set(scope.candidate_kinds ?? []);
  const outOfDomainKinds = new Set(scope.out_of_domain_issue_kinds ?? []);
  const sourceExtensions = new Set(scope.source_extensions ?? []);
  return rows.map(row => {
    if (outOfDomainKinds.has(row.kind)) {
      return { ...row, candidate_state: 'out-of-code-candidate-domain', consumer_references: [] };
    }
    if (!candidateKinds.has(row.kind)) return invalidCandidateEvidence(row, 'issue-kind-is-not-declared-in-candidate-or-out-of-domain-scope');
    const candidatePath = typeof row.file === 'string' ? row.file : row.path;
    if (typeof candidatePath !== 'string' || !candidatePath || path.posix.isAbsolute(candidatePath)
      || path.posix.normalize(candidatePath) !== candidatePath || candidatePath.startsWith('../')) {
      return invalidCandidateEvidence(row, 'candidate-source-path-is-missing-or-not-canonical');
    }
    if (!trackedSources.has(candidatePath)) return invalidCandidateEvidence(row, 'candidate-source-path-is-not-in-the-complete-tracked-inventory');
    if (!sourceExtensions.has(path.posix.extname(candidatePath))) return invalidCandidateEvidence(row, 'candidate-source-path-has-an-undeclared-source-extension');
    if (!pathMatchesAnyPrefix(candidatePath, scope.audited_source_prefixes ?? [])) {
      return invalidCandidateEvidence(row, 'candidate-source-path-is-outside-the-audited-source-inventory');
    }
    if (!pathMatchesAnyPrefix(candidatePath, scope.candidate_source_prefixes ?? [])) {
      return { ...row, candidate_state: 'out-of-code-candidate-domain', consumer_references: [] };
    }
    if (row.kind === 'exports' && (typeof row.name !== 'string' || !row.name.trim())) {
      return invalidCandidateEvidence(row, 'candidate-export-name-is-missing');
    }
    const lineCount = lineCounts[candidatePath];
    if (!Number.isSafeInteger(row.line) || row.line < 1 || !Number.isSafeInteger(lineCount) || row.line > lineCount) {
      return invalidCandidateEvidence(row, 'candidate-source-line-is-missing-or-out-of-range');
    }
    const consumers = audit.references.filter(reference => reference.target_path === candidatePath
      && (row.kind === 'files'
        || reference.imported_symbols.includes('*')
        || reference.imported_symbols.includes(row.name)));
    const exactSymbolConsumers = consumers.filter(reference => reference.imported_symbols.includes(row.name));
    const broadConsumers = consumers.some(reference => reference.imported_symbols.includes('*'));
    const state = (row.kind === 'files' && consumers.length > 0)
      || exactSymbolConsumers.length > 0 || broadConsumers
      ? 'retained-by-source-reference'
      : audit.graph_qualified
        ? 'candidate-in-qualified-graph'
        : 'unknown-incomplete-graph';
    return { ...row, candidate_state: state, consumer_references: consumers };
  });
}

export function validateUnusedCandidateRows(rows) {
  const invalidRows = rows.map((row, index) => ({ row, index }))
    .filter(({ row }) => row.candidate_state === 'unknown-invalid-candidate-evidence')
    .map(({ row, index }) => ({
      index,
      ref: row.ref ?? null,
      kind: row.kind ?? null,
      path: row.file ?? row.path ?? null,
      reason: row.candidate_evidence_issue,
    }));
  return { complete: invalidRows.length === 0, invalid_count: invalidRows.length, invalid_rows: invalidRows };
}

export function qualifiedUnusedPayload(rows, graphQualified, scope) {
  if (!graphQualified || !Array.isArray(scope?.candidate_kinds) || scope.candidate_kinds.length === 0
    || rows.some(row => row.candidate_state === 'unknown-invalid-candidate-evidence')) return null;
  const candidateKinds = new Set(scope.candidate_kinds);
  const candidates = rows.filter(row => candidateKinds.has(row.kind) && row.candidate_state === 'candidate-in-qualified-graph');
  const validated = candidates.filter(row => row.triage?.classification === 'validated-candidate');
  const falsePositives = candidates.filter(row => row.triage?.classification === 'false-positive');
  const uncertain = candidates.filter(row => row.triage?.classification !== 'validated-candidate'
    && row.triage?.classification !== 'false-positive');
  return {
    graph_status: 'qualified',
    candidate_count: candidates.length,
    validated_count: validated.length,
    false_positive_count: falsePositives.length,
    uncertain_count: uncertain.length,
    owner_validation_refs: validated.length > 0 ? ['ref:unused-triage-source'] : [],
    graph_qualification_ref: 'ref:unused-reference-audit',
  };
}
