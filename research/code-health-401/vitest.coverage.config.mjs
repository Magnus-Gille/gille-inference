import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

const repoRoot = resolve(process.cwd());
const reportDir = resolve(repoRoot, "research/code-health-401/artifacts/correction/ts-coverage-scoped");

export default defineConfig({
  root: repoRoot,
  test: {
    globals: true,
    include: [
      "tests/homeserver-errors.test.ts",
      "tests/homeserver-policy-task-type-identity.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/gate-d/**", "**/.claude/**", "data/**"],
    coverage: {
      enabled: true,
      provider: "v8",
      reporter: ["json-summary", "text"],
      reportsDirectory: reportDir,
      include: [
        "src/homeserver/errors.ts",
        "src/homeserver/task-type-identity.ts",
        "src/homeserver/image-sidecar.ts",
      ],
      exclude: ["**/*.d.ts"],
    },
  },
});
