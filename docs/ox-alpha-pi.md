# Nous Ox Alpha through headless Pi

`stealth/ox-alpha` is available from Nous through an OpenAI Chat Completions-compatible API. The
repo launcher uses headless Pi because the current Codex client emits `namespace` tools that the
Nous endpoint rejects; Pi emits standard function tools and its bundled subagent extension starts
isolated child Pi processes.

## Safety and configuration

- No API key is stored in Git, Pi settings, shell arguments, or a session file. The launcher reads
  `NOUS_API_KEY` from the environment or asks for it without echo on `/dev/tty` for each run. It
  then deletes the key from the child environment and keeps it only in the launcher's credential
  proxy. Pi, its shell tool, and subagents receive only a random per-run loopback token.
- Read-only mode is the default. It exposes `ox-scout`, `ox-planner`, and `ox-reviewer`, all without
  shell or mutation tools.
- `--write` is explicit. It adds root mutation tools and the bounded `ox-worker` profile. Parallel
  workers must not edit the same checkout; use read-only parallel scouts and serialize mutations.
- Each run is ephemeral (`--no-session`), ignores project-local Pi extensions, disables unrelated
  skills and prompt templates, and retains the repository's `AGENTS.md` context.
- The launcher limits wall time to 600 seconds by default, terminates the whole Pi process group on
  timeout, and stops after 2 MiB of combined output.
- A loopback proxy accepts only authenticated `POST /v1/chat/completions`, caps request bodies at
  64 MiB, adds the upstream Nous credential in memory, streams the response, and closes with the
  agent run. The temporary Pi profile contains neither the raw key nor the public Nous URL.

Pi 0.84.x from `@earendil-works/pi-coding-agent` is required because the launcher uses its bundled
`examples/extensions/subagent/index.ts`. The path is derived from the installed `pi` executable;
`OX_PI_BIN` and `OX_PI_SUBAGENT_EXTENSION` are explicit escape hatches for nonstandard installs.

## Usage

Read-only analysis with the model's default/max effort:

```bash
npm run agent:ox -- "Use two ox-scout agents in parallel to inspect routing and tests"
```

Explicit implementation lane, lower effort, and a five-minute bound:

```bash
npm run agent:ox -- --write --thinking low --timeout 300 "Implement the bounded leaf and review it"
```

The Nous model catalog advertises exactly `low`, `high`, and `max`; `max` is the model default and
the launcher default. `medium`, `xhigh`, and other Pi levels are deliberately unavailable in these
profiles. Inspect the resolved non-secret invocation without contacting Nous:

```bash
npm run agent:ox -- --dry-run
```

For automation, inject `NOUS_API_KEY` through the caller's secret facility. The committed
`models.json` files are source templates; the launcher materializes a mode-specific temporary copy
that points to its loopback proxy. Do not put the key in a command argument, committed `.env`,
transcript, or issue. Because a key shared in chat is already exposed, rotate it after the
experiment even if the account currently has no credits.

## Verification

```bash
npm test -- tests/ox-agent.test.ts
npm run typecheck
git diff --check
```

The live acceptance probe asks the parent to run two `ox-scout` tasks in parallel against separate
fixtures and requires the exact combined result `SUBAGENT_OK A17 B29`. It intentionally uses the
read-only profile.
