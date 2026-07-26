# Secret scanning

CI runs Gitleaks on every pull request and push. Pull requests use the
action's precise PR-commit range. Pushes also run `--log-opts='--all'` after
the action, over every reachable commit, so initial scans and revalidation
cover the full graph. The checkout always has full history. A detected leak
fails the job.

Run the same full-history scan locally with an installed Gitleaks 8.24.3:

```bash
gitleaks detect --config .gitleaks.toml --source . --log-opts='--all' --redact
```

The CI job also creates an uncommitted, invented test marker and checks that
this configuration rejects it. The marker has its own narrow rule and is not a
credential format. Run that configuration check locally after installing the
same version of Gitleaks:

```bash
scripts/verify-gitleaks-config.sh
```

## Allowlist policy

All allowlist entries must be narrow, documented false positives using only
invented values: exact literal, exact path, and a short explanation. Never
allowlist a live credential, a credential-shaped production value, an entire
rule, or a broad directory. Rotate a real secret immediately and remove it
from history where appropriate; an allowlist is not remediation.
