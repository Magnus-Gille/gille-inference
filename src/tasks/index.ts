import type { TaskDefinition, TaskCategory, DifficultyLevel } from '../types.js';
import { CODING_TASKS } from './coding.js';
import { NON_CODING_TASKS } from './non-coding.js';
import { REAL_WORLD_TASKS } from './real-world.js';
import { GRIMNIR_TASKS } from './grimnir.js';
import { DELEGATED_TASKS } from './delegated.js';
import { COMPOUND_TASKS } from './compound.js';

// ---------------------------------------------------------------------------
// Compound task stubs for judge compatibility
// ---------------------------------------------------------------------------
// Compound tasks run through the orchestrator and produce shadow run records
// in the `runs` table with task_ids like "ct-001". The judge looks up task
// definitions by id — so we need TaskDefinition stubs for each compound task.

const CATEGORY_MAP: Record<string, TaskCategory> = {
  'ct-001': 'multi-file',
  'ct-002': 'non-coding',
  'ct-003': 'debugging',
  'ct-004': 'non-coding',
  'ct-005': 'architecture',
  'ct-006': 'multi-file',
  'ct-007': 'non-coding',
};

export const COMPOUND_TASK_STUBS: TaskDefinition[] = COMPOUND_TASKS.map((ct) => ({
  id: ct.id,
  category: (CATEGORY_MAP[ct.id] ?? 'multi-file') as TaskCategory,
  title: ct.title,
  prompt: ct.description,
  expectedCapabilities: ct.subTasks.map((st) => st.title),
  difficulty: 4 as DifficultyLevel,
  tags: ['compound', 'orchestration'],
  maxTokens: ct.synthesisMaxTokens,
}));

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const ALL_TASKS: TaskDefinition[] = [
  ...CODING_TASKS,
  ...NON_CODING_TASKS,
  ...REAL_WORLD_TASKS,
  ...GRIMNIR_TASKS,
  ...DELEGATED_TASKS,
  ...COMPOUND_TASK_STUBS,
];

// ---------------------------------------------------------------------------
// Validation (runs at import time — throws on bad task data)
// ---------------------------------------------------------------------------

const VALID_CATEGORIES = new Set<TaskCategory>([
  'simple-coding',
  'refactoring',
  'architecture',
  'debugging',
  'multi-file',
  'reasoning',
  'non-coding',
]);

const VALID_DIFFICULTIES = new Set<DifficultyLevel>([1, 2, 3, 4, 5]);

function validateTasks(tasks: TaskDefinition[]): void {
  const ids = new Set<string>();

  for (const task of tasks) {
    // Unique IDs
    if (ids.has(task.id)) {
      throw new Error(`Duplicate task ID: "${task.id}"`);
    }
    ids.add(task.id);

    // Required string fields non-empty
    if (!task.id || task.id.trim() === '') {
      throw new Error('Task has an empty id');
    }
    if (!task.title || task.title.trim() === '') {
      throw new Error(`Task "${task.id}" has an empty title`);
    }
    if (!task.prompt || task.prompt.trim() === '') {
      throw new Error(`Task "${task.id}" has an empty prompt`);
    }

    // At least one expected capability
    if (!task.expectedCapabilities || task.expectedCapabilities.length === 0) {
      throw new Error(`Task "${task.id}" has no expectedCapabilities`);
    }

    // Valid category
    if (!VALID_CATEGORIES.has(task.category)) {
      throw new Error(`Task "${task.id}" has invalid category: "${task.category as string}"`);
    }

    // Valid difficulty
    if (!VALID_DIFFICULTIES.has(task.difficulty)) {
      throw new Error(`Task "${task.id}" has invalid difficulty: ${task.difficulty}`);
    }

    // maxTokens positive
    if (typeof task.maxTokens !== 'number' || task.maxTokens <= 0) {
      throw new Error(`Task "${task.id}" has invalid maxTokens: ${task.maxTokens}`);
    }

    // tags is an array
    if (!Array.isArray(task.tags)) {
      throw new Error(`Task "${task.id}" has invalid tags (must be array)`);
    }
  }
}

// Run validation immediately at module load
validateTasks(ALL_TASKS);

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

export function getTaskById(id: string): TaskDefinition | undefined {
  return ALL_TASKS.find((t) => t.id === id);
}

export function getTasksByCategory(category: TaskCategory): TaskDefinition[] {
  return ALL_TASKS.filter((t) => t.category === category);
}

export function getTasksByDifficulty(min: DifficultyLevel, max: DifficultyLevel): TaskDefinition[] {
  return ALL_TASKS.filter((t) => t.difficulty >= min && t.difficulty <= max);
}

// Re-export sub-arrays and types for convenience
export { CODING_TASKS } from './coding.js';
export { NON_CODING_TASKS } from './non-coding.js';
export { REAL_WORLD_TASKS } from './real-world.js';
export { GRIMNIR_TASKS } from './grimnir.js';
export { DELEGATED_TASKS } from './delegated.js';
export type { TaskDefinition, TaskCategory, DifficultyLevel } from '../types.js';
