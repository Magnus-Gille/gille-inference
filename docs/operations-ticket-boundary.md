# Public engineering and private operations tickets

Gille Inference is public, but it owns a real production service. Its ticket workflow therefore
separates reusable engineering truth from live operator execution.

## Classification

| Work | Correct home | Allowed detail |
|---|---|---|
| Code, architecture, product behavior, generic runbook | This repository's issue or pull request | Public-safe problem, intended contract, sanitized evidence, tests, generic rollback |
| Deployment, incident, or maintenance execution | Private Grimnir operations tracker | Exact non-secret live paths, host-specific state, rollout timing, backups, canary and rollback evidence |
| Current single-operator handoff | Gitignored local `STATUS.md` | Exact private next step and transient state |
| Security vulnerability | This repository's draft security advisory | Exploit and private fix discussion |
| Credentials or retained content | Secret/data store only | Never place in any ticket |

Private visibility is not permission to store secrets. Credentials, tokens, `.env` contents,
prompts, responses, databases, owner logs, customer data, and raw sensitive logs never belong in
the private tracker either.

## Public ticket contract

A public operational-engineering ticket should contain:

1. the public problem or capability objective;
2. intended behavior and explicit non-goals;
3. sanitized evidence or a reproducible fixture;
4. safety, compatibility, and authority impact;
5. generic preconditions, canary criteria, and rollback semantics;
6. tests or other acceptance evidence.

Use placeholders such as `<runtime-root>`, `<model-root>`, `<tailnet-ip>`, `example.com`, and
`/srv/gille-inference`. Do not include personal home paths, private addresses or hostnames, live
working directories, exact backup locations, production logs, active key aliases, or raw command
output.

The public ticket may say that operator execution is tracked privately. It must not expose the
private ticket's title, URL, topology, or execution detail.

## Private execution record

The corresponding private deployment, incident, or maintenance ticket:

- names this repository as the single code/architecture owner;
- links the accepted public issue or pull request;
- records exact non-secret prechecks, backup, execution, canary, verification, and rollback;
- references protected evidence instead of copying its contents;
- closes with the deployed revision, outcome, rollback state, and follow-up.

The private tracker coordinates execution only. Any discovered code, architecture, or reusable
runbook change returns here as a sanitized issue or pull request.
