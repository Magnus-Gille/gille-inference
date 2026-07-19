/**
 * routing-table-diff.ts — semantic diff + capability-regression classification for
 * docs/m5-routing.json regeneration (issue #151).
 *
 * Incident (2026-07-04, #150): during routing-table adoption, `reason-hard` silently regressed
 * delegate-local → escalate-frontier because its 2026-06-23 extra-probes evidence was lost from
 * disk. The generator failed SAFE (frontier, never a guessed local id) but also failed SILENT —
 * the system that exists to notice competence changes did not notice its own competence
 * regressing; a human reading generator output did.
 *
 * This module is the noticing. It compares the currently-adopted table against a freshly
 * regenerated one and classifies every task type's change:
 *
 *   - DOWNGRADE — the route's capability rank dropped (delegate-local > explore >
 *     escalate-frontier) or the type vanished from the table. Alerted; adoption requires
 *     explicit acknowledgment (--accept-downgrades in the generator script).
 *   - MISSING EVIDENCE — the downgrade sub-class behind the incident: the adopted table proves
 *     the capability was measured (a better-than-frontier route), but the regeneration found
 *     ZERO attempts. Evidence expected but missing ≠ genuinely never probed; the former must
 *     fail loudly, the latter stays a quiet pending hole.
 *   - upgrade / model-change / added — informational, never alarmed.
 *
 * PURE (no fs / no DB): takes two already-parsed tables, returns a classification. The IO layer
 * (scripts/generate-routing-table.ts) decides what to do with it.
 */

// ── Diffable shapes (tolerant subset of both the loader's RoutingTable and the ────
//    generator's RoutingTableDoc, plus hand-edited legacy tables)

export interface DiffableRoutingEntry {
  model?: string | null;
  verdict?: string;
  /** Verdict-relevant attempts behind the entry; absent on hand-edited legacy tables. */
  attempts?: number;
}

export interface DiffableRoutingTable {
  routing?: Record<string, DiffableRoutingEntry>;
  generatedAt?: string;
}

export type RouteChangeKind =
  | "upgrade"
  | "downgrade"
  | "model-change"
  | "added"
  | "removed"
  | "unchanged";

export interface RouteSnapshot {
  model: string | null;
  verdict: string;
  attempts: number | null;
}

export interface RouteChange {
  taskType: string;
  kind: RouteChangeKind;
  before: RouteSnapshot | null;
  after: RouteSnapshot | null;
  /**
   * True when a downgrade/removal is explained by evidence going MISSING rather than by a
   * measured failure: the adopted table had a better-than-frontier route (the capability was
   * measured once) and the regeneration found ZERO attempts behind the type. This is the
   * #150 incident class — it must alarm as "expected evidence absent", not read as a quiet
   * pending hole.
   */
  evidenceMissing: boolean;
  detail: string;
}

export interface RoutingTableDiff {
  /** Every task type present in either table, sorted, including unchanged ones. */
  changes: RouteChange[];
  /** Capability regressions (kind downgrade or removed-with-capability) — the alarm set. */
  downgrades: RouteChange[];
  /** Subset of downgrades where the regression is explained by missing evidence. */
  missingEvidence: RouteChange[];
}

// ── Ranking ──────────────────────────────────────────────────────────────────────

/**
 * Capability rank of a routing entry: delegate-local (2) > explore (1) > escalate-frontier (0).
 * A null/blank/missing model ranks 0 regardless of the verdict string — the same drift-safety
 * rule routingTarget() applies (an entry that names no real local model IS a frontier route).
 * An unrecognized verdict string with a real model ranks 1 (conservative middle: a drop to
 * frontier still alarms, a rise to delegate-local still counts as an upgrade).
 */
export function verdictRank(entry: Pick<DiffableRoutingEntry, "model" | "verdict">): 0 | 1 | 2 {
  const model = entry.model;
  if (model == null || model.trim() === "") return 0;
  if (entry.verdict === "delegate-local") return 2;
  if (entry.verdict === "escalate-frontier") return 0;
  return 1; // "explore" and anything unrecognized-but-local
}

function snapshot(entry: DiffableRoutingEntry): RouteSnapshot {
  return {
    model: entry.model ?? null,
    verdict: entry.verdict ?? "",
    attempts: typeof entry.attempts === "number" ? entry.attempts : null,
  };
}

function describe(s: RouteSnapshot | null): string {
  if (s === null) return "(absent)";
  const verdict = s.verdict || "unknown-verdict";
  return `${verdict}(${s.model ?? "null"})`;
}

// ── Diff ─────────────────────────────────────────────────────────────────────────

export function diffRoutingTables(
  current: DiffableRoutingTable,
  next: DiffableRoutingTable
): RoutingTableDiff {
  const cur = current.routing ?? {};
  const nxt = next.routing ?? {};
  const types = [...new Set([...Object.keys(cur), ...Object.keys(nxt)])].sort();

  const changes: RouteChange[] = [];
  for (const taskType of types) {
    const beforeEntry = cur[taskType];
    const afterEntry = nxt[taskType];
    const before = beforeEntry ? snapshot(beforeEntry) : null;
    const after = afterEntry ? snapshot(afterEntry) : null;
    const beforeRank = beforeEntry ? verdictRank(beforeEntry) : null;
    const afterRank = afterEntry ? verdictRank(afterEntry) : null;

    let kind: RouteChangeKind;
    if (beforeRank === null) {
      kind = "added";
    } else if (afterRank === null) {
      kind = "removed";
    } else if (afterRank > beforeRank) {
      kind = "upgrade";
    } else if (afterRank < beforeRank) {
      kind = "downgrade";
    } else if ((before?.model ?? null) !== (after?.model ?? null)) {
      kind = "model-change";
    } else {
      kind = "unchanged";
    }

    // The incident class: the capability WAS measured (better-than-frontier route in the
    // adopted table) but the regeneration's evidence SHRANK — zero attempts (total loss), or,
    // for a drop to frontier, fewer attempts than the adopted entry recorded (PARTIAL loss,
    // e.g. a truncated re-import: still escalates with attempts>0 but the evidence went
    // missing, it wasn't measured away). A measured regression accumulates evidence — its
    // attempts don't shrink below the adopted level.
    const hadCapability = (beforeRank ?? 0) > 0;
    const afterAttempts = after?.attempts ?? 0;
    const evidenceShrank =
      afterAttempts === 0 ||
      (afterRank === 0 && before?.attempts != null && afterAttempts < before.attempts);
    const evidenceMissing =
      (kind === "removed" && hadCapability) ||
      (kind === "downgrade" && hadCapability && evidenceShrank);

    changes.push({
      taskType,
      kind,
      before,
      after,
      evidenceMissing,
      detail:
        kind === "unchanged"
          ? `${taskType}: ${describe(before)}`
          : `${taskType}: ${describe(before)} → ${describe(after)}${
              evidenceMissing
                ? " [EVIDENCE MISSING — this type had probe evidence; the regeneration found none. Expected-but-missing, not never-probed.]"
                : ""
            }`,
    });
  }

  const downgrades = changes.filter(
    (c) => c.kind === "downgrade" || (c.kind === "removed" && (c.before ? verdictRank(c.before) : 0) > 0)
  );
  return {
    changes,
    downgrades,
    missingEvidence: downgrades.filter((c) => c.evidenceMissing),
  };
}

// ── Human-readable report ──────────────────────────────────────────────────────────

export function formatRoutingDiff(diff: RoutingTableDiff): string {
  const changed = diff.changes.filter((c) => c.kind !== "unchanged");
  if (changed.length === 0) {
    return "semantic diff vs adopted table: no semantic routing changes\n";
  }
  const lines: string[] = [`semantic diff vs adopted table (${changed.length} change(s)):`];
  for (const c of changed) {
    const mark = c.kind === "downgrade" || c.kind === "removed" ? "DOWNGRADE" : c.kind;
    lines.push(`  [${mark}] ${c.detail}`);
  }
  if (diff.downgrades.length > 0) {
    lines.push(
      `  ${diff.downgrades.length} DOWNGRADE(s), of which ${diff.missingEvidence.length} from missing evidence.`
    );
  }
  return lines.join("\n") + "\n";
}
