/** LOCAL candidate entry point. Deliberately no file/envelope/provider/credential CLI input.
 * A reviewed real provider, durable root CAS and atomic no-replace publisher are not installed.
 */
import { pathToFileURL } from "node:url";
import { issueAccountedHostAdmission } from "../src/homeserver/accounted-host-issuer.js";

export async function main(): Promise<number> {
  const result = await issueAccountedHostAdmission({}, undefined);
  process.stdout.write(JSON.stringify(result) + "\n");
  return 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
