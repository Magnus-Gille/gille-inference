#!/usr/bin/env tsx
/**
 * post-readiness-journey.ts — run one content-free `gateway-model-readiness` attempt and deliver
 * the closed synthetic-journey-outcome v1 document to Heimdall (INFER-250 / HEIM-49).
 *
 * Configuration comes only from the environment (host-owned private file, never argv):
 *   GATEWAY_READINESS_URL                gateway origin: https, or http only to loopback, e.g. http://127.0.0.1:<port>
 *   GATEWAY_READINESS_MONITOR_KEY        read-only monitor-scope key
 *   HEIMDALL_SYNTHETIC_JOURNEYS_URL      https://<heimdall>/api/synthetic-journeys
 *   HEIMDALL_GATEWAY_JOURNEY_TOKEN       dedicated gateway journey credential
 *
 * Exit status: 0 when a runner-ok outcome (pass OR fail) was delivered — a failing dependency is
 * Heimdall's alert to raise, not a failed unit. Exit 1 when delivery failed or the runner itself
 * failed (bad config/credential), so those are visible in systemd. Output is one JSON line of classes only.
 */
import { readFileSync } from "node:fs";
import { deliverOutcome, runReadinessAttempt } from "../src/homeserver/readiness-journey.js";

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return `gille-inference@${pkg.version ?? "0.0.0"}`;
  } catch {
    return "gille-inference@0.0.0";
  }
}

const outcome = await runReadinessAttempt({
  gatewayUrl: process.env["GATEWAY_READINESS_URL"],
  monitorKey: process.env["GATEWAY_READINESS_MONITOR_KEY"],
  version: packageVersion(),
});
const delivery = await deliverOutcome(outcome, {
  url: process.env["HEIMDALL_SYNTHETIC_JOURNEYS_URL"],
  token: process.env["HEIMDALL_GATEWAY_JOURNEY_TOKEN"],
});
process.stdout.write(`${JSON.stringify({
  journey_id: outcome.journey_id,
  outcome: outcome.outcome,
  runner_outcome: outcome.runner_outcome,
  error_class: outcome.error_class,
  delivered: delivery.delivered,
  attempts: delivery.attempts,
  delivery_error: delivery.error ?? null,
})}\n`);
// A runner failure (bad config/credential) is invisible to Heimdall's alerts (unknown is not
// graded), so it must fail the unit here.
process.exitCode = delivery.delivered && outcome.runner_outcome === "ok" ? 0 : 1;
