/**
 * analyze-prompts.ts
 * Reads data/prompts-classified.jsonl and produces a statistical breakdown.
 *
 * Outputs:
 *   1. Distribution by category
 *   2. Distribution by complexity
 *   3. Distribution by min_model_tier  (key offload answer)
 *   4. Cross-tabulation: category × min_model_tier
 *   5. Per-project breakdown of min_model_tier
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

interface Classification {
  category: string;
  complexity: string;
  min_model_tier: string;
  reasoning: string;
}

interface ClassifiedPrompt {
  project: string;
  prompt: string;
  char_count: number;
  session_id: string;
  classification: Classification;
}

function pct(n: number, total: number): string {
  return ((n / total) * 100).toFixed(1) + '%';
}

function printDistribution(
  title: string,
  counts: Map<string, number>,
  total: number,
  orderedKeys?: string[]
) {
  console.log(`\n### ${title}`);
  const keys = orderedKeys ?? [...counts.keys()].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0));
  for (const key of keys) {
    const n = counts.get(key) ?? 0;
    const bar = '█'.repeat(Math.round((n / total) * 40));
    console.log(`  ${key.padEnd(18)} ${n.toString().padStart(5)}  ${pct(n, total).padStart(6)}  ${bar}`);
  }
}

function main() {
  const inputPath = resolve(process.cwd(), 'data', 'prompts-classified.jsonl');

  if (!existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`);
    console.error('Run classify-prompts.ts first.');
    process.exit(1);
  }

  const lines = readFileSync(inputPath, 'utf-8').split('\n').filter(Boolean);
  const prompts: ClassifiedPrompt[] = lines.map((line) => JSON.parse(line) as ClassifiedPrompt);

  const total = prompts.length;
  console.log(`\n=== Prompt Classification Analysis ===`);
  console.log(`Total classified prompts: ${total}`);

  // 1. Distribution by category
  const byCat = new Map<string, number>();
  for (const p of prompts) {
    const cat = p.classification.category;
    byCat.set(cat, (byCat.get(cat) ?? 0) + 1);
  }
  printDistribution('Category Distribution', byCat, total);

  // 2. Distribution by complexity
  const byComplexity = new Map<string, number>();
  for (const p of prompts) {
    const c = p.classification.complexity;
    byComplexity.set(c, (byComplexity.get(c) ?? 0) + 1);
  }
  const complexityOrder = ['trivial', 'simple', 'moderate', 'complex'];
  printDistribution('Complexity Distribution', byComplexity, total, complexityOrder);

  // 3. Distribution by min_model_tier
  const byTier = new Map<string, number>();
  for (const p of prompts) {
    const t = p.classification.min_model_tier;
    byTier.set(t, (byTier.get(t) ?? 0) + 1);
  }
  const tierOrder = ['edge', 'local-small', 'local-large', 'frontier'];
  printDistribution('Min Model Tier Distribution (KEY METRIC)', byTier, total, tierOrder);

  // Summary: what fraction could run locally?
  const edge = byTier.get('edge') ?? 0;
  const localSmall = byTier.get('local-small') ?? 0;
  const localLarge = byTier.get('local-large') ?? 0;
  const frontier = byTier.get('frontier') ?? 0;
  const localTotal = edge + localSmall + localLarge;

  console.log(`\n  Offload potential summary:`);
  console.log(`    edge+local-small (Gemma4-E2B / GLM-4.7):  ${edge + localSmall} / ${total} = ${pct(edge + localSmall, total)}`);
  console.log(`    any local model (≤local-large):           ${localTotal} / ${total} = ${pct(localTotal, total)}`);
  console.log(`    needs frontier (Claude/GPT-4):            ${frontier} / ${total} = ${pct(frontier, total)}`);

  // 4. Cross-tabulation: category × min_model_tier
  const catTierMap = new Map<string, Map<string, number>>();
  for (const p of prompts) {
    const cat = p.classification.category;
    const tier = p.classification.min_model_tier;
    if (!catTierMap.has(cat)) catTierMap.set(cat, new Map());
    const inner = catTierMap.get(cat)!;
    inner.set(tier, (inner.get(tier) ?? 0) + 1);
  }

  console.log('\n### Cross-tab: Category × Min Model Tier');
  const tierHeaders = tierOrder.map((t) => t.padEnd(13)).join(' ');
  console.log(`  ${'Category'.padEnd(18)}  ${tierHeaders}  total`);
  console.log(`  ${'-'.repeat(18)}  ${tierOrder.map(() => '-'.repeat(13)).join(' ')}  -----`);

  const sortedCats = [...catTierMap.keys()].sort((a, b) => (byCat.get(b) ?? 0) - (byCat.get(a) ?? 0));
  for (const cat of sortedCats) {
    const tierCounts = catTierMap.get(cat)!;
    const catTotal = [...tierCounts.values()].reduce((s, v) => s + v, 0);
    const cols = tierOrder.map((t) => {
      const n = tierCounts.get(t) ?? 0;
      return `${n.toString().padStart(4)} (${pct(n, catTotal).padStart(5)})`.padEnd(13);
    }).join(' ');
    console.log(`  ${cat.padEnd(18)}  ${cols}  ${catTotal}`);
  }

  // 5. Per-project breakdown of min_model_tier
  const projectTierMap = new Map<string, Map<string, number>>();
  for (const p of prompts) {
    const proj = p.project;
    const tier = p.classification.min_model_tier;
    if (!projectTierMap.has(proj)) projectTierMap.set(proj, new Map());
    const inner = projectTierMap.get(proj)!;
    inner.set(tier, (inner.get(tier) ?? 0) + 1);
  }

  console.log('\n### Per-Project Breakdown (min_model_tier)');
  console.log(`  ${'Project'.padEnd(55)}  ${'edge'.padEnd(6)}  ${'l-sm'.padEnd(6)}  ${'l-lg'.padEnd(6)}  ${'front'.padEnd(6)}  total  local%`);
  console.log(`  ${'-'.repeat(55)}  ------  ------  ------  ------  -----  ------`);

  const sortedProjects = [...projectTierMap.keys()].sort((a, b) => {
    const aTotal = [...(projectTierMap.get(a)?.values() ?? [])].reduce((s, v) => s + v, 0);
    const bTotal = [...(projectTierMap.get(b)?.values() ?? [])].reduce((s, v) => s + v, 0);
    return bTotal - aTotal;
  });

  for (const proj of sortedProjects) {
    const tierCounts = projectTierMap.get(proj)!;
    const e = tierCounts.get('edge') ?? 0;
    const ls = tierCounts.get('local-small') ?? 0;
    const ll = tierCounts.get('local-large') ?? 0;
    const f = tierCounts.get('frontier') ?? 0;
    const projTotal = e + ls + ll + f;
    const localPct = pct(e + ls + ll, projTotal);
    const shortProj = proj.length > 55 ? '...' + proj.slice(-52) : proj;
    console.log(
      `  ${shortProj.padEnd(55)}  ` +
      `${e.toString().padStart(6)}  ` +
      `${ls.toString().padStart(6)}  ` +
      `${ll.toString().padStart(6)}  ` +
      `${f.toString().padStart(6)}  ` +
      `${projTotal.toString().padStart(5)}  ` +
      `${localPct.padStart(6)}`
    );
  }

  console.log('\n=== End of Analysis ===\n');
}

main();
