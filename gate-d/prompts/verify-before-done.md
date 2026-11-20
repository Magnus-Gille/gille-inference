Before you finish a coding task, verify your own work:

1. Run the type checker, `npx --no-install tsc --noEmit`, and fix every error it reports.
2. Run every test or oracle file the task names, and any test file you wrote or changed, with
   `npx --no-install tsx <file>`. Fix every failure.
3. Re-read the task and confirm each stated requirement is met, including names it asks for,
   limits on how often something may appear, and files you must not modify.

Stop only when all three hold. If a check fails, keep working instead of stopping.
