/** Pure create-only bootstrap artifact planner. Never reads/writes a host,
 * initializes a backend on open, accepts an existing journal, resets or repairs.
 */
import {createHash} from "node:crypto";
import {z} from "zod";
import {canonicalNative} from "./accounted-host-issuer.js";
import {encodeInitialAccountedIssuerFileRecord} from "./accounted-issuer-file-storage.js";
const uuid=z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$(?![\s\S])/);
const hex=z.string().regex(/^[0-9a-f]{64}$(?![\s\S])/);
const configuration=z.object({mandateId:uuid,hostBootId:uuid,observerInstanceSha256:hex}).strict();
const sha=(value:string)=>createHash("sha256").update(value).digest("hex");
export function accountedIssuerJournalDirectory(mandateId:string):string {
  return "/var/lib/brokkr-accounted/issuer/"+uuid.parse(mandateId);
}
export function planAccountedIssuerJournalBootstrap(raw:unknown) {
  const accepted=configuration.parse(JSON.parse(canonicalNative(raw)));
  const state={schemaVersion:1,hostBootIdSha256:sha(accepted.hostBootId),observerInstanceSha256:accepted.observerInstanceSha256,
    lastSequence:0,seenEvidenceDigests:[],seenAttempts:[],claims:[]};
  const record=encodeInitialAccountedIssuerFileRecord(state);
  const journal=Object.freeze({mandate_id:accepted.mandateId,observer_instance_sha256:accepted.observerInstanceSha256,
    origin_version:record.version,bytes_sha256:sha(record.bytes),bytes:record.bytes});
  return Object.freeze({schemaVersion:1 as const,directory:accountedIssuerJournalDirectory(accepted.mandateId),
    directoryOwnerUid:0 as const,directoryMode:0o700,file:"journal.json" as const,fileOwnerUid:0 as const,fileMode:0o600,
    expectedPreimage:"absent" as const,createOnly:true as const,journal,
    installationAuthorized:false as const,executionAuthorized:false as const});
}
