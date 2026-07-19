/**
 * classify-prompts.ts
 * Classifies each extracted prompt using z-ai/glm-4.7-flash via OpenRouter.
 *
 * Input:  data/prompts-extracted.jsonl
 * Output: data/prompts-classified.jsonl
 *
 * Usage:
 *   tsx scripts/classify-prompts.ts [--resume]
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import OpenAI from 'openai';
import { loadEnv } from '../src/env.js';

loadEnv();

interface ExtractedPrompt {
  project: string;
  prompt: string;
  char_count: number;
  session_id: string;
}

interface Classification {
  category: 'coding' | 'debugging' | 'architecture' | 'documentation' | 'question' | 'admin' | 'data-analysis' | 'communication' | 'other';
  complexity: 'trivial' | 'simple' | 'moderate' | 'complex';
  min_model_tier: 'edge' | 'local-small' | 'local-large' | 'frontier';
  reasoning: string;
}

interface ClassifiedPrompt extends ExtractedPrompt {
  classification: Classification;
}

const BATCH_CONCURRENCY = 20;
const PROGRESS_INTERVAL = 50;
// qwen/qwen-2.5-7b-instruct: non-reasoning, fast (~2s), cheap (~$0.004/M input).
// z-ai/glm-4.7-flash is a reasoning model that uses all tokens for internal chain-of-thought
// and returns null content unless max_tokens >> 1000, making it expensive and slow.
const MODEL = 'qwen/qwen-2.5-7b-instruct';
const MAX_PROMPT_CHARS = 2000;

function buildClassificationPrompt(promptText: string): string {
  const truncated = promptText.length > MAX_PROMPT_CHARS
    ? promptText.slice(0, MAX_PROMPT_CHARS) + '...'
    : promptText;

  return `Classify this user prompt from a Claude Code session. The user is a senior software engineer.
Output ONLY valid JSON with: category, complexity, min_model_tier, reasoning.

category options: coding|debugging|architecture|documentation|question|admin|data-analysis|communication|other
complexity options: trivial|simple|moderate|complex
min_model_tier options: edge|local-small|local-large|frontier
  - "edge" = Gemma4-E2B could handle this (simple questions, basic text, trivial code)
  - "local-small" = GLM-4.7-Flash level (moderate tasks, standard code generation)
  - "local-large" = Gemma4-26B or Qwen3.5 level (quality code, analysis, multi-step)
  - "frontier" = needs Claude/GPT-4 (complex architecture, nuanced reasoning, large context)

Prompt: """
${truncated}
"""`;
}

const FALLBACK_CLASSIFICATION: Classification = {
  category: 'other',
  complexity: 'simple',
  min_model_tier: 'local-small',
  reasoning: 'classification failed',
};

function parseClassification(raw: string): Classification {
  // Strip markdown fences if present
  const cleaned = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  try {
    const obj = JSON.parse(cleaned) as Partial<Classification>;

    const validCategories = new Set(['coding', 'debugging', 'architecture', 'documentation', 'question', 'admin', 'data-analysis', 'communication', 'other']);
    const validComplexities = new Set(['trivial', 'simple', 'moderate', 'complex']);
    const validTiers = new Set(['edge', 'local-small', 'local-large', 'frontier']);

    const category = validCategories.has(obj.category ?? '') ? obj.category! : 'other';
    const complexity = validComplexities.has(obj.complexity ?? '') ? obj.complexity! : 'simple';
    const min_model_tier = validTiers.has(obj.min_model_tier ?? '') ? obj.min_model_tier! : 'local-small';
    const reasoning = typeof obj.reasoning === 'string' ? obj.reasoning.slice(0, 200) : 'no reasoning';

    return { category, complexity, min_model_tier, reasoning };
  } catch {
    return FALLBACK_CLASSIFICATION;
  }
}

async function classifyOne(
  client: OpenAI,
  prompt: ExtractedPrompt
): Promise<ClassifiedPrompt> {
  const systemPrompt = buildClassificationPrompt(prompt.prompt);

  try {
    const response = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content: systemPrompt }],
      max_tokens: 200,
      temperature: 0,
    });

    const raw = response.choices[0]?.message?.content ?? '';
    const classification = parseClassification(raw);

    return { ...prompt, classification };
  } catch (err) {
    console.warn(`  Classification failed for prompt ${prompt.session_id}: ${err}`);
    return { ...prompt, classification: FALLBACK_CLASSIFICATION };
  }
}

async function processBatch(
  client: OpenAI,
  batch: ExtractedPrompt[],
  outputPath: string
): Promise<ClassifiedPrompt[]> {
  const results = await Promise.all(batch.map((p) => classifyOne(client, p)));

  // Append results to output file immediately (streaming write)
  for (const result of results) {
    appendFileSync(outputPath, JSON.stringify(result) + '\n', 'utf-8');
  }

  return results;
}

function loadAlreadyClassified(outputPath: string): Set<string> {
  const seen = new Set<string>();
  if (!existsSync(outputPath)) return seen;

  const lines = readFileSync(outputPath, 'utf-8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as ClassifiedPrompt;
      // Use a composite key: session_id + first 100 chars of prompt
      seen.add(`${obj.session_id}::${obj.prompt.slice(0, 100)}`);
    } catch {
      // skip
    }
  }
  return seen;
}

async function main() {
  const resume = process.argv.includes('--resume');

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error('OPENROUTER_API_KEY environment variable is required');
    process.exit(1);
  }

  const inputPath = resolve(process.cwd(), 'data', 'prompts-extracted.jsonl');
  const outputPath = resolve(process.cwd(), 'data', 'prompts-classified.jsonl');

  if (!existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`);
    console.error('Run extract-prompts.ts first.');
    process.exit(1);
  }

  // Read all extracted prompts
  const rawLines = readFileSync(inputPath, 'utf-8').split('\n').filter(Boolean);
  const allPrompts: ExtractedPrompt[] = rawLines.map((line) => JSON.parse(line) as ExtractedPrompt);

  console.log(`Loaded ${allPrompts.length} prompts from ${inputPath}`);

  // Handle resume
  let alreadyClassified: Set<string>;
  if (resume) {
    alreadyClassified = loadAlreadyClassified(outputPath);
    console.log(`Resuming: ${alreadyClassified.size} already classified, skipping those`);
  } else {
    alreadyClassified = new Set();
    // Truncate output file
    writeFileSync(outputPath, '', 'utf-8');
  }

  const promptsToClassify = allPrompts.filter((p) => {
    const key = `${p.session_id}::${p.prompt.slice(0, 100)}`;
    return !alreadyClassified.has(key);
  });

  console.log(`Classifying ${promptsToClassify.length} prompts using ${MODEL}`);
  console.log(`Concurrency: ${BATCH_CONCURRENCY}`);

  const client = new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey,
  });

  let processed = 0;
  const startTime = Date.now();

  for (let i = 0; i < promptsToClassify.length; i += BATCH_CONCURRENCY) {
    const batch = promptsToClassify.slice(i, i + BATCH_CONCURRENCY);
    await processBatch(client, batch, outputPath);
    processed += batch.length;

    if (processed % PROGRESS_INTERVAL === 0 || processed === promptsToClassify.length) {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = processed / elapsed;
      const remaining = promptsToClassify.length - processed;
      const eta = remaining / rate;
      console.log(
        `Progress: ${processed}/${promptsToClassify.length} ` +
        `(${((processed / promptsToClassify.length) * 100).toFixed(1)}%) ` +
        `| ${rate.toFixed(1)} prompts/s | ETA: ${eta.toFixed(0)}s`
      );
    }
  }

  const totalInOutput = alreadyClassified.size + processed;
  console.log(`\nDone. Total classified: ${totalInOutput}`);
  console.log(`Output: ${outputPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
