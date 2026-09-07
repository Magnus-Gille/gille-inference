# Served provenance snapshots

The served provenance command records a bounded, content-blind observation of one already-running
`llama-server` process. It is an evidence artifact for a benchmark or review. It does not change
the process, call the gateway, load a model, or prove that any particular bytes are resident in
GPU memory.

The process collector is Linux-only because it reads `/proc`. Other operating systems are
unsupported and must fail closed as unavailable rather than infer process or artifact evidence.

## Capture a snapshot

Capture is explicit and may be costly because model and runtime files can be hashed on every run.
There is no internal cache and the command does not write a file. Redirect its JSON output to a
private path outside the repository:

`fresh` means only that this capture detected no change while it ran. It does not establish
continuing currentness or prove which bytes are loaded or served. Retain the capture timestamp
with the report. Any model, runtime, launch/configuration, or process-restart change invalidates
reuse; recapture explicitly after such changes and before comparison. Consumers must not assume
automatic caching or revalidation.

```sh
umask 077
npm run --silent provenance:served -- \
  --pid 12345 \
  --alias demo-public \
  --gateway-build 0123456789abcdef0123456789abcdef01234567 \
  > /tmp/private-served-provenance-2026-09-07T120000Z.json
```

The path and timestamp above are examples; use a private, same-mount path on the serving host. Keep
the resulting snapshot with the benchmark record that it describes. Do not add private process
observations or snapshots to Git.

The command accepts:

- `--pid POSITIVE_INTEGER`: the process to inspect. The collector performs only OS-permitted,
  read-only process and artifact reads. On Linux, artifact reads require the target and collector
  to share a mount namespace and the target root to have the same device/inode identity as the
  collector root. Absolute paths stay inside `/proc/PID/root`; relative paths resolve from
  `/proc/PID/cwd`. Remote locators and traversal are rejected. A final artifact-path symlink is
  unsupported and fails closed with `artifact-hash-failed`; `/proc/PID/exe` is the deliberate
  process-executable magic-link exception. An incompatible process view leaves artifact evidence
  incomplete.
- `--alias SAFE_ALIAS`: an explicit operator-declared public label matching
  `[A-Za-z0-9._-]{1,128}`. It is a label supplied by the operator; it is not a claim that the
  gateway verified the label.
- `--gateway-build LOWERCASE_SHA`: an optional operator-declared 40-character lowercase Git SHA.
  It is recorded as a declaration and is never treated as an observed build identity.
- `--help`: print usage and exit successfully.

Unknown flags, duplicate flags, missing values, and invalid values are rejected. The command has no
`--out` flag and performs no internal file writes. It uses no authentication helpers, network,
HTTP, or MCP calls.

## Exit status and consumer checks

For a valid request, stdout contains one JSON snapshot and the command exits `0`, even when the
snapshot is incomplete. Consumers must inspect all of `completeness`, `freshness`, `reasons`, and
the `binding` and `source` fields before using a snapshot as evidence. A valid JSON document is not
the same thing as complete evidence.

Invalid arguments and internal fatal failures exit `1` and write only a fixed, enumerated error
code to stderr. Supplied arguments, process paths, and raw exception text are never echoed. A
successful but incomplete observation keeps its fixed reason codes in the JSON contract.

## Schema contract

Schema version `1` contains:

- `schemaVersion`, `modelAlias`, `observedAt`, `freshness`, `completeness`, `reasons`, and the
  stable `configurationIdentity`.
- `artifacts.weights`, normalized `artifacts.projector`, `artifacts.runtimeBinary`, and
  `artifacts.gatewayBuild`. An omitted or unresolved projector is normalized to an unknown
  artifact; `{"kind":"not-applicable"}` is reserved for a separately established absence. The
  process collector reports unknown when `--mmproj` is absent because it does not inspect
  environment or configuration sources. Artifact digests identify observed content when
  available; each artifact also carries a binding state.
- `identities.quantization`, `identities.tokenizer`, and `identities.chatTemplate`.
- `launchConfiguration`, which records numeric values recovered from the observed launch command
  line. A missing flag, ambiguous/invalid flag, or unavailable process is unknown. This is separate
  from `effectiveConfiguration`: launch flags alone do not establish runtime effective defaults or
  limits, and per-request overrides are deliberately absent. Version 1 normalizes an omitted
  `launchConfiguration` to all-unknown evidence for its seven fields. The first collector leaves
  effective defaults and limits, quantization, tokenizer, and chat-template identities unknown;
  no live snapshot has established those values. Consumers must not treat omitted or unknown
  values as retrieved defaults.
- `environment` information such as OS, architecture, CPU count, memory, and resource ceilings.
  Host facts may be observed while resource ceilings remain explicit `null` unknowns.

Evidence values say whether they are `observed`, `operator-declared`, or `unknown`. An unknown or
operator-declared required value keeps the snapshot incomplete. The operator-supplied alias and
gateway build are declarations, not gateway verification or immutable-startup evidence.

`configurationIdentity` is a stable SHA-256 identity over artifact content identities, model
identities, effective configuration, and launch configuration. The operator-selected `modelAlias`
is a public display label and is deliberately excluded; changing the label does not represent a
runtime configuration change. Observation time and environment are also excluded, so the identity
can be compared across captures without claiming that the runtime environment was the same.

## Loaded-byte boundary

The collector always reports loaded-byte binding as `unproven` or `stale`; no command flag can
upgrade it. A digest of a path on disk does not prove that the same bytes were loaded into the
running process or GPU. This tool cannot provide retrospective disk-to-GPU proof, and live
immutable-startup binding remains unsupported. The first collector does not establish a loaded
binding. It detects changes observed during capture, but a same-size rewrite completed within the
filesystem timestamp resolution may evade stat-based detection; `fresh` therefore means only that
no change was detected during that capture. A detected artifact replacement or loss of the process
makes the relevant evidence stale or unavailable.

The snapshot is therefore evidence to retain with a benchmark, not a reproducibility guarantee or
a performance guarantee. It does not turn an incomplete observation into an operational M2 or
issue #293 completion claim.

## Synthetic example

The following is a synthetic public example. The hashes are deliberately fake, and the unknown
fields and `unproven` bindings make the snapshot incomplete. It is illustrative only and is not a
live observation:

```json
{
  "schemaVersion": 1,
  "modelAlias": "demo-public",
  "observedAt": "2026-09-07T12:00:00.000Z",
  "freshness": "fresh",
  "completeness": "incomplete",
  "reasons": [
    "required-evidence-unknown",
    "required-evidence-operator-declared",
    "served-bytes-unproven"
  ],
  "artifacts": {
    "weights": [
      {
        "contentSha256": {
          "source": "observed",
          "value": "1111111111111111111111111111111111111111111111111111111111111111"
        },
        "binding": "unproven"
      }
    ],
    "projector": {
      "kind": "not-applicable"
    },
    "runtimeBinary": {
      "contentSha256": {
        "source": "unknown",
        "reason": "required-evidence-unknown"
      },
      "binding": "unproven"
    },
    "gatewayBuild": {
      "sha": {
        "source": "operator-declared",
        "value": "2222222222222222222222222222222222222222"
      },
      "binding": "unproven"
    }
  },
  "identities": {
    "quantization": {
      "source": "unknown",
      "reason": "required-evidence-unknown"
    },
    "tokenizer": {
      "source": "unknown",
      "reason": "required-evidence-unknown"
    },
    "chatTemplate": {
      "source": "unknown",
      "reason": "required-evidence-unknown"
    }
  },
  "launchConfiguration": {
    "contextSize": {
      "source": "observed",
      "value": 4096
    },
    "parallelism": {
      "source": "observed",
      "value": 1
    },
    "temperature": {
      "source": "observed",
      "value": 0.2
    },
    "topP": {
      "source": "observed",
      "value": 0.95
    },
    "topK": {
      "source": "unknown",
      "reason": "required-evidence-unknown"
    },
    "minP": {
      "source": "observed",
      "value": 0
    },
    "predictLimit": {
      "source": "observed",
      "value": 256
    }
  },
  "effectiveConfiguration": {
    "contextTokens": {
      "source": "unknown",
      "reason": "required-evidence-unknown"
    },
    "defaults": {
      "maxTokens": {
        "source": "unknown",
        "reason": "required-evidence-unknown"
      },
      "temperature": {
        "source": "unknown",
        "reason": "required-evidence-unknown"
      },
      "topP": {
        "source": "unknown",
        "reason": "required-evidence-unknown"
      },
      "topK": {
        "source": "unknown",
        "reason": "required-evidence-unknown"
      },
      "minP": {
        "source": "unknown",
        "reason": "required-evidence-unknown"
      }
    },
    "limits": {
      "maxTokens": {
        "source": "unknown",
        "reason": "required-evidence-unknown"
      },
      "maxInputTokens": {
        "source": "unknown",
        "reason": "required-evidence-unknown"
      },
      "maxOutputTokens": {
        "source": "unknown",
        "reason": "required-evidence-unknown"
      }
    }
  },
  "environment": {
    "source": "observed",
    "value": {
      "os": "linux",
      "arch": "arm64",
      "cpuCount": 12,
      "memoryBytes": 68719476736,
      "resourceCeilings": {
        "cpuCount": null,
        "memoryBytes": null
      }
    }
  },
  "configurationIdentity": "sha256:e2bd1236bc8cdaa30c836708242d69353821103b2ff69ac44db2a19ec8fe630b"
}
```

The existing Strix provenance tool remains unchanged. Existing path-based ledger identities are
also unchanged; this schema does not silently migrate them.
