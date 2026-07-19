/**
 * extract-prompts.ts
 * Reads all Claude Code session transcripts from ~/.claude/projects/ and extracts
 * real user prompts (filtering out noise like slash commands and tool results).
 *
 * Output: data/prompts-extracted.jsonl
 *   { project: string, prompt: string, char_count: number, session_id: string }
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';

interface ExtractedPrompt {
  project: string;
  prompt: string;
  char_count: number;
  session_id: string;
}

interface JsonlUserMessage {
  type: string;
  message?: {
    role?: string;
    content?: string | unknown[];
  };
  sessionId?: string;
}

/**
 * Returns true if the text is purely a slash command or local command output.
 * These are noise, not real user prompts.
 */
function isNoise(text: string): boolean {
  // Purely slash command invocations
  if (text.trimStart().startsWith('<command-name>')) return true;
  if (text.trimStart().startsWith('<command-message>')) return true;

  // Local command output injected into the conversation
  if (text.trimStart().startsWith('<local-command-caveat>')) return true;
  if (text.trimStart().startsWith('<local-command-stdout>')) return true;
  if (text.trimStart().startsWith('<local-command-stderr>')) return true;
  if (text.trimStart().startsWith('<bash-input>')) return true;
  if (text.trimStart().startsWith('<bash-stdout>')) return true;
  if (text.trimStart().startsWith('<bash-stderr>')) return true;

  // Task notifications (background agent completions)
  if (text.trimStart().startsWith('<task-notification>')) return true;

  // If the entire message is wrapped in an XML-style tag pair — usually injected context
  const firstTagMatch = text.trimStart().match(/^<([a-z][a-z0-9_-]*)>/i);
  if (firstTagMatch) {
    const tag = firstTagMatch[1];
    // Only filter if the entire (trimmed) message is that tag block
    const closeTag = `</${tag}>`;
    if (text.trimStart().startsWith(`<${tag}>`) && text.trimEnd().endsWith(closeTag)) {
      return true;
    }
  }

  return false;
}

async function readJsonlFile(filePath: string): Promise<JsonlUserMessage[]> {
  const messages: JsonlUserMessage[] = [];
  const fileStream = createReadStream(filePath);
  const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as JsonlUserMessage;
      messages.push(obj);
    } catch {
      // Skip malformed lines
    }
  }
  return messages;
}

async function extractPromptsFromFile(
  filePath: string,
  projectName: string,
  sessionId: string
): Promise<ExtractedPrompt[]> {
  const results: ExtractedPrompt[] = [];
  let messages: JsonlUserMessage[];
  try {
    messages = await readJsonlFile(filePath);
  } catch {
    return results;
  }

  for (const obj of messages) {
    if (obj.type !== 'user') continue;

    const content = obj.message?.content;
    if (!content) continue;

    // Tool results (list content) are not user prompts
    if (Array.isArray(content)) continue;

    const text = content as string;

    // Minimum length filter
    if (text.length < 20) continue;

    // Noise filter
    if (isNoise(text)) continue;

    results.push({
      project: projectName,
      prompt: text,
      char_count: text.length,
      session_id: sessionId,
    });
  }

  return results;
}

async function main() {
  const claudeProjectsDir = join(homedir(), '.claude', 'projects');

  if (!existsSync(claudeProjectsDir)) {
    console.error(`Claude projects directory not found: ${claudeProjectsDir}`);
    process.exit(1);
  }

  const outputPath = resolve(process.cwd(), 'data', 'prompts-extracted.jsonl');

  const projectDirs = readdirSync(claudeProjectsDir).filter((name) => {
    const fullPath = join(claudeProjectsDir, name);
    return statSync(fullPath).isDirectory();
  });

  console.log(`Found ${projectDirs.length} project directories`);

  const allPrompts: ExtractedPrompt[] = [];
  let filesProcessed = 0;
  let filesSkipped = 0;

  for (const projectName of projectDirs) {
    const projectPath = join(claudeProjectsDir, projectName);
    const files = readdirSync(projectPath).filter((f) => f.endsWith('.jsonl'));

    for (const fileName of files) {
      const filePath = join(projectPath, fileName);
      const sessionId = fileName.replace('.jsonl', '');

      try {
        const prompts = await extractPromptsFromFile(filePath, projectName, sessionId);
        allPrompts.push(...prompts);
        filesProcessed++;
      } catch (err) {
        console.warn(`  Skipped ${fileName}: ${err}`);
        filesSkipped++;
      }
    }
  }

  console.log(`\nProcessed ${filesProcessed} files, skipped ${filesSkipped}`);
  console.log(`Extracted ${allPrompts.length} prompts`);

  // Write output
  const lines = allPrompts.map((p) => JSON.stringify(p));
  writeFileSync(outputPath, lines.join('\n') + '\n', 'utf-8');
  console.log(`\nOutput written to: ${outputPath}`);

  // Quick stats
  const byProject = new Map<string, number>();
  for (const p of allPrompts) {
    byProject.set(p.project, (byProject.get(p.project) ?? 0) + 1);
  }
  const top10 = [...byProject.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  console.log('\nTop 10 projects by prompt count:');
  for (const [proj, count] of top10) {
    console.log(`  ${count.toString().padStart(4)}  ${proj}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
