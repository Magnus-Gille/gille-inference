# Harness² candidate profile (issue #495)

This directory prepares a **plan**, never starts a process, installs a runtime,
reads authentication, or qualifies a host. The existing `code-loop-cage.ts`
provides the systemd/Bubblewrap precedent. This profile separates the trusted
subscription client from candidate execution: candidate commands have no model
relay or network route. It does not alter the production code-loop cage.

A host operator must qualify the exact rendered plan under a separately approved
controlled-evaluation envelope. `grimnir-ops#21` owns that private operation.
The plan uses a pinned rootless Podman image so candidate tools cannot see host
runtimes, credentials, sockets or homes. A bounded tmpfs workspace remains inside
one container for the campaign; seed/harvest happen through bounded pipes and
never add a host bind. This is a launch plan, not an implemented seed/harvest or
Pi bridge. Those integration and native negative tests remain required.

Run the pure tests with `python3 -m unittest discover -s scripts/harness2_profile -p 'test_*.py'`. Render with `python3 scripts/harness2_profile/profile.py INPUT.json`.
The CLI only reads the declaration and writes JSON to stdout.
