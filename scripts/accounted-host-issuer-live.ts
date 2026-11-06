/** LOCAL staged entrypoint. The no-admission branch is implemented; diagnostic
 * providers still require real accepted inventory/allocation/coverage evidence.
 * Neither a root file nor this executable creates owner execution authority.
 */
import {dirname} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {createAccountedHostIoBridge, executeAccountedHostIo, type AccountedIoBinding} from "../src/homeserver/accounted-host-io.js";
import {runAccountedIssuerSelfTest} from "../src/homeserver/accounted-issuer-self-test.js";

interface EntryDependencies {
  platform: string; effectiveUid: number | undefined; entryPath: string;
  openIo: (binding: AccountedIoBinding) => ReturnType<typeof createAccountedHostIoBridge>;
  selfTest: typeof runAccountedIssuerSelfTest;
  write: (value: string) => void;
}
function defaults(): EntryDependencies {
  return {platform:process.platform,effectiveUid:process.geteuid?.(),entryPath:fileURLToPath(import.meta.url),
    openIo:binding=>createAccountedHostIoBridge(binding,executeAccountedHostIo),selfTest:runAccountedIssuerSelfTest,
    write:value=>{process.stdout.write(value);}};
}
/** Dependencies are configured code capabilities for isolated tests, not CLI
 * input. The production executor separately checks actual root/Linux identity.
 */
export function main(argv: readonly string[] = process.argv.slice(2), dependencies: EntryDependencies = defaults()): number {
  const emit = (value: unknown) => dependencies.write(JSON.stringify(value)+"\n");
  const refused = (reason: string) => {emit({status:"refused",reason,executionAuthorized:false});return 2;};
  if (dependencies.platform !== "linux" || dependencies.effectiveUid !== 0) {
    emit({status:"refused",reason:"root_linux_required",executionAuthorized:false}); return 78;
  }
  // Do not run an incomplete diagnostic branch, signal ready, initialize replay
  // or turn missing real verification into an admission-shaped acknowledgement.
  if (argv.length === 2) return refused("live_provider_integration_required");
  if (argv.length !== 3 || argv[2] !== "--self-test") return refused("arguments");
  const entry = /^\/opt\/gille-inference-accounted\/releases\/([0-9a-f]{64})\/accounted-host-issuer\.mjs$(?![\s\S])/.exec(dependencies.entryPath);
  const configuration = /^\/etc\/gille-inference-accounted\/attempts\/([0-9a-f]{32})\.json$(?![\s\S])/.exec(argv[0] ?? "");
  if (!entry || !configuration || typeof argv[1] !== "string" || !/^[0-9a-f]{64}$(?![\s\S])/.test(argv[1])) return refused("entry_binding");
  try {
    const io = dependencies.openIo({helperPath:dirname(dependencies.entryPath)+"/accounted-host-io.py",
      configurationPath:argv[0],configurationDigest:argv[1]});
    const selfTestIo=Object.freeze({configuration:io.configuration,context:io.context,initializeClock:io.initializeClock,
      clock:io.clock,recordSelfTest:io.recordSelfTest});
    const result = dependencies.selfTest({attemptId:configuration[1],issuerReleaseDigest:entry[1],configurationDigest:argv[1]},selfTestIo);
    emit(result); return 0;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? (error as {code:unknown}).code : undefined;
    const reason = typeof code === "string" && /^[a-z][a-z0-9_]{0,63}$(?![\s\S])/.test(code) ? code : "issuer_self_test_unresolved";
    // A clock/audit write might already exist. Retain the attempt; never retry,
    // remove its files, or describe an ambiguous acknowledgement as safe refusal.
    emit({status:"unknown",reason,admissionPublished:false,executionAuthorized:false}); return 2;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
