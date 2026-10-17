# Security policy

## Supported versions

Security fixes are made on the current `main` branch. This project has not reached a stable 1.0
server release, so older commits and deployments are not supported.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository. If that feature is not
available, open an issue containing only a request for a private reporting channel. Do not include
the vulnerability, credentials, prompts, customer data, network topology, or other sensitive
details in a public issue.

You should receive an acknowledgement within seven days. A fix timeline depends on severity and
whether the affected path is enabled by default.

## Deployment responsibility

Gille Inference is self-hosted software, not a managed security boundary. Operators are responsible
for TLS termination, network exposure, identity and key lifecycle, model provenance, backups,
monitoring, and local sandbox support. Keep the gateway loopback- or private-network-bound unless a
reviewed authenticating reverse proxy is in front of it. Never commit a populated `.env`, runtime
database, owner log, model file, key store, or tunnel credential.

The code-loop cage depends on Linux namespaces and Bubblewrap. Treat it as defense in depth, review
its documented assumptions, and do not expose tool-running routes to untrusted users.

## Evaluation execution

The model-evaluation path (`scripts/evaluate-model.ts`, `homeserver probe`, and the `tsGate`/`sqlExec`
verifiers) executes model-generated code. Grader children receive an allowlisted environment (no
`.env` values, no `HOMESERVER_*`/`M5_*` secrets, no `NODE_OPTIONS`/`NODE_PATH`), a scratch
`HOME`/`TMPDIR`, the scratch directory as their working directory, and `tsGate` refuses to run as
root.

That is containment of the environment, not a sandbox of the process: a child can still read any
file the running identity can reach by absolute path. Run evaluations as the dedicated unprivileged
evaluator identity prepared by `scripts/prepare-model-evaluation-registry.sh` — never as the gateway
service user or root, and with no access to `.env`, `data/`, or gateway runtime state. Unlike the
code-loop cage, probe execution has no namespace or Bubblewrap confinement.
