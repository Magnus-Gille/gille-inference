import { describe, it, expect } from 'vitest';
import {
  ALL_TASKS,
  CODING_TASKS,
  NON_CODING_TASKS,
  REAL_WORLD_TASKS,
  GRIMNIR_TASKS,
  DELEGATED_TASKS,
  COMPOUND_TASK_STUBS,
  getTaskById,
  getTasksByCategory,
  getTasksByDifficulty,
} from '../src/tasks/index.js';

const VALID_CATEGORIES = [
  'simple-coding',
  'refactoring',
  'architecture',
  'debugging',
  'multi-file',
  'reasoning',
  'non-coding',
] as const;

const VALID_DIFFICULTIES = [1, 2, 3, 4, 5] as const;

describe('Task registry', () => {
  it('exports the expected task composition (coding + non-coding + real-world + grimnir + delegated + compound)', () => {
    expect(CODING_TASKS).toHaveLength(15);
    expect(NON_CODING_TASKS).toHaveLength(5);
    expect(REAL_WORLD_TASKS).toHaveLength(15);
    expect(GRIMNIR_TASKS).toHaveLength(16);
    expect(DELEGATED_TASKS).toHaveLength(12);
    expect(COMPOUND_TASK_STUBS).toHaveLength(7);
    // ALL_TASKS is exactly the concatenation of the sub-registries — this
    // invariant catches an accidentally dropped or double-counted group.
    expect(ALL_TASKS).toHaveLength(
      CODING_TASKS.length +
        NON_CODING_TASKS.length +
        REAL_WORLD_TASKS.length +
        GRIMNIR_TASKS.length +
        DELEGATED_TASKS.length +
        COMPOUND_TASK_STUBS.length
    );
    expect(ALL_TASKS).toHaveLength(70);
    // Exact membership + order: a task moved between sub-registries keeps the
    // total at 70 but changes membership — a length check alone wouldn't catch it.
    expect(ALL_TASKS).toEqual([
      ...CODING_TASKS,
      ...NON_CODING_TASKS,
      ...REAL_WORLD_TASKS,
      ...GRIMNIR_TASKS,
      ...DELEGATED_TASKS,
      ...COMPOUND_TASK_STUBS,
    ]);
  });

  it('all task IDs are unique', () => {
    const ids = ALL_TASKS.map((t) => t.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('all tasks have non-empty prompts', () => {
    for (const task of ALL_TASKS) {
      expect(task.prompt.trim().length, `Task ${task.id} has empty prompt`).toBeGreaterThan(0);
    }
  });

  it('all tasks have at least one expectedCapability', () => {
    for (const task of ALL_TASKS) {
      expect(
        task.expectedCapabilities.length,
        `Task ${task.id} has no expectedCapabilities`
      ).toBeGreaterThan(0);
    }
  });

  it('all tasks have valid difficulty (1-5)', () => {
    for (const task of ALL_TASKS) {
      expect(
        VALID_DIFFICULTIES.includes(task.difficulty as (typeof VALID_DIFFICULTIES)[number]),
        `Task ${task.id} has invalid difficulty: ${task.difficulty}`
      ).toBe(true);
    }
  });

  it('all tasks have valid category', () => {
    for (const task of ALL_TASKS) {
      expect(
        VALID_CATEGORIES.includes(task.category as (typeof VALID_CATEGORIES)[number]),
        `Task ${task.id} has invalid category: ${task.category}`
      ).toBe(true);
    }
  });

  it('all tasks have non-empty title', () => {
    for (const task of ALL_TASKS) {
      expect(task.title.trim().length, `Task ${task.id} has empty title`).toBeGreaterThan(0);
    }
  });

  it('all tasks have positive maxTokens', () => {
    for (const task of ALL_TASKS) {
      expect(task.maxTokens, `Task ${task.id} has invalid maxTokens`).toBeGreaterThan(0);
    }
  });

  it('all tasks have a tags array', () => {
    for (const task of ALL_TASKS) {
      expect(Array.isArray(task.tags), `Task ${task.id} tags is not an array`).toBe(true);
    }
  });
});

describe('Task ID naming conventions', () => {
  it('coding tasks have expected ID prefixes', () => {
    const simpleTasks = CODING_TASKS.filter((t) => t.category === 'simple-coding');
    const refactorTasks = CODING_TASKS.filter((t) => t.category === 'refactoring');
    const archTasks = CODING_TASKS.filter((t) => t.category === 'architecture');
    const debugTasks = CODING_TASKS.filter((t) => t.category === 'debugging');
    const multiTasks = CODING_TASKS.filter((t) => t.category === 'multi-file');
    const reasonTasks = CODING_TASKS.filter((t) => t.category === 'reasoning');

    expect(simpleTasks.length).toBe(4);
    expect(refactorTasks.length).toBe(3);
    expect(archTasks.length).toBe(2);
    expect(debugTasks.length).toBe(3);
    expect(multiTasks.length).toBe(2);
    expect(reasonTasks.length).toBe(1);

    expect(simpleTasks.every((t) => t.id.startsWith('simple-'))).toBe(true);
    expect(refactorTasks.every((t) => t.id.startsWith('refactor-'))).toBe(true);
    expect(archTasks.every((t) => t.id.startsWith('arch-'))).toBe(true);
    expect(debugTasks.every((t) => t.id.startsWith('debug-'))).toBe(true);
    expect(multiTasks.every((t) => t.id.startsWith('multi-'))).toBe(true);
    expect(reasonTasks.every((t) => t.id.startsWith('reason-'))).toBe(true);
  });

  it('non-coding tasks have expected ID prefix', () => {
    expect(NON_CODING_TASKS.every((t) => t.id.startsWith('noncoding-'))).toBe(true);
  });
});

describe('getTaskById', () => {
  it('returns the correct task for a known ID', () => {
    const task = getTaskById('simple-001');
    expect(task).toBeDefined();
    expect(task?.title).toBe('Swedish Personnummer Validator');
  });

  it('returns undefined for an unknown ID', () => {
    expect(getTaskById('does-not-exist')).toBeUndefined();
  });
});

describe('getTasksByCategory', () => {
  it('returns only tasks of the requested category', () => {
    const debugTasks = getTasksByCategory('debugging');
    expect(debugTasks.length).toBeGreaterThan(0);
    expect(debugTasks.every((t) => t.category === 'debugging')).toBe(true);
  });

  it('returns all and only the non-coding tasks (registry count pinned)', () => {
    const tasks = getTasksByCategory('non-coding');
    // Helper soundness: every returned task really is non-coding.
    expect(tasks.every((t) => t.category === 'non-coding')).toBe(true);
    // Independent contract: the registry's non-coding count is pinned, so a task
    // silently flipping category (the regression issue #1 warns about) turns
    // this red — and CI now runs it.
    expect(tasks).toHaveLength(40);
  });
});

describe('getTasksByDifficulty', () => {
  it('returns tasks within the difficulty range', () => {
    const tasks = getTasksByDifficulty(1, 2);
    expect(tasks.every((t) => t.difficulty >= 1 && t.difficulty <= 2)).toBe(true);
    expect(tasks.length).toBeGreaterThan(0);
  });

  it('returns all tasks for range 1-5', () => {
    expect(getTasksByDifficulty(1, 5)).toHaveLength(ALL_TASKS.length);
  });

  it('returns no tasks for an impossible range (5,1)', () => {
    expect(getTasksByDifficulty(5, 1)).toHaveLength(0);
  });
});

describe('Tasks with hidden tests', () => {
  it('hidden tests have required fields', () => {
    const tasksWithHidden = ALL_TASKS.filter((t) => t.hiddenTests && t.hiddenTests.length > 0);
    expect(tasksWithHidden.length).toBeGreaterThan(0);

    for (const task of tasksWithHidden) {
      for (const ht of task.hiddenTests!) {
        expect(ht.description.trim().length, `Hidden test in ${task.id} missing description`).toBeGreaterThan(0);
        expect(ht.input.trim().length, `Hidden test in ${task.id} missing input`).toBeGreaterThan(0);
        expect(ht.expectedOutput.trim().length, `Hidden test in ${task.id} missing expectedOutput`).toBeGreaterThan(0);
      }
    }
  });

  it('simple-001 has hidden tests', () => {
    const task = getTaskById('simple-001');
    expect(task?.hiddenTests?.length).toBeGreaterThan(0);
  });

  it('debug-001 has hidden tests', () => {
    const task = getTaskById('debug-001');
    expect(task?.hiddenTests?.length).toBeGreaterThan(0);
  });
});

describe('Specific task content sanity checks', () => {
  it('simple-001 mentions Luhn', () => {
    const task = getTaskById('simple-001');
    expect(task?.prompt.toLowerCase()).toContain('luhn');
  });

  it('reason-001 is difficulty 5', () => {
    const task = getTaskById('reason-001');
    expect(task?.difficulty).toBe(5);
  });

  it('noncoding-003 is tagged with swedish', () => {
    const task = getTaskById('noncoding-003');
    expect(task?.tags).toContain('swedish');
  });

  it('multi-002 mentions vitest', () => {
    const task = getTaskById('multi-002');
    expect(task?.prompt.toLowerCase()).toContain('vitest');
  });

  it('noncoding-001 contains the fictional API document inline', () => {
    const task = getTaskById('noncoding-001');
    expect(task?.prompt).toContain('Nordljus');
  });

  it('noncoding-003 contains Swedish invoice email inline', () => {
    const task = getTaskById('noncoding-003');
    expect(task?.prompt).toContain('faktura');
  });
});
