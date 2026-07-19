import { defineConfig, configDefaults } from "vitest/config";
export default defineConfig({
  test: {
    globals: true,
    // Keep agent/worktree copies (.claude/worktrees/**) out of the run — they
    // duplicate tests/ and inflate pass/fail counts. Also exclude the root
    // data/ tree — gitignored experiment scratch (e.g. data/overnight/workspace
    // /tests reference model-generated src files that may never have been
    // written). Root-anchored ("data/**", not "**/data/**") so a future committed
    // fixture under a nested */data/ dir is not silently skipped.
    // gate-d/** holds agentic-coding TASK FIXTURES (gate-d/tasks/*/{repo,solution}/test/*.test.ts)
    // — oracle-style assertion scripts run by gate-d/check.sh via tsx, NOT vitest suites. Without
    // this exclude, vitest's default `**/*.test.ts` glob picks up e.g. task 05's clamp.test.ts and
    // fails it with "No test suite found".
    exclude: [...configDefaults.exclude, "**/.claude/**", "data/**", "gate-d/**"],
  },
});
