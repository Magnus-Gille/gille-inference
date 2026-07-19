# Contributing

Thanks for helping improve Gille Inference.

## Before opening a change

- Discuss large features or architecture changes in an issue first.
- Keep credentials, real prompts, private addresses, personal paths, production logs, databases,
  and model files out of commits and test fixtures.
- Use reserved examples such as `example.com`, `192.0.2.0/24`, and `/srv/gille-inference` in
  documentation and tests.
- Add a regression test for behavior changes and manually review generated or benchmark data
  before committing it.

## Development

The project requires a supported Node.js release (Node 20, 22, 23, 24, or 25) and npm.

```bash
npm ci
npm run typecheck
npm test
npm audit --omit=dev
git diff --check
```

Run the smallest affected test first while developing. Changes to the code-loop, authentication,
admission, routing, request logging, or public gateway should also update the relevant threat model
or operational documentation.

## Pull requests

Explain the problem, the security or compatibility impact, and the validation performed. Keep one
logical change per pull request. By contributing, you agree that your contribution is licensed
under the repository's MIT License.
