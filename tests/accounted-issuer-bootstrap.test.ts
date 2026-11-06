import {describe,expect,it} from "vitest";
import {createHash} from "node:crypto";
import {accountedIssuerJournalDirectory,planAccountedIssuerJournalBootstrap} from "../src/homeserver/accounted-issuer-bootstrap.js";
const input={mandateId:"7d195545-ccb9-40c9-9d19-577150de149d",hostBootId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",observerInstanceSha256:"b".repeat(64)};
describe("create-only journal artifact; no host effects",()=>{
  it("plans one exact root-owned empty replay journal bound to boot and observer",()=>{
    const plan=planAccountedIssuerJournalBootstrap(input),record=JSON.parse(plan.journal.bytes);
    expect(plan).toMatchObject({directory:"/var/lib/brokkr-accounted/issuer/"+input.mandateId,file:"journal.json",
      directoryMode:0o700,fileMode:0o600,expectedPreimage:"absent",createOnly:true,installationAuthorized:false,executionAuthorized:false});
    expect(record.state).toEqual({schemaVersion:1,hostBootIdSha256:createHash("sha256").update(input.hostBootId).digest("hex"),
      observerInstanceSha256:input.observerInstanceSha256,lastSequence:0,seenEvidenceDigests:[],seenAttempts:[],claims:[]});
    expect(record.revision).toBe("0");expect(record.originVersion).toBe(null);expect(record.parentVersion).toBe(null);
    expect(plan.journal.origin_version).toBe(createHash("sha256").update("gille-inference/accounted/file-journal/v1\n"+plan.journal.bytes).digest("hex"));
  });
  it("never accepts existing state, arbitrary directories or a reset/rearm input",()=>{
    for(const changed of [{...input,state:{claims:[]}},{...input,directory:"/tmp/elsewhere"},{...input,reset:true},
      {...input,mandateId:"../../elsewhere"},{...input,hostBootId:input.hostBootId+"\n"}]){
      expect(()=>planAccountedIssuerJournalBootstrap(changed)).toThrow();
    }
    expect(()=>accountedIssuerJournalDirectory("../x")).toThrow();
  });
  it("is deterministic and does not retain mutable caller state",()=>{
    const caller={...input},first=planAccountedIssuerJournalBootstrap(caller);
    caller.hostBootId="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    expect(planAccountedIssuerJournalBootstrap(input)).toEqual(first);
    expect(planAccountedIssuerJournalBootstrap(caller).journal.origin_version).not.toBe(first.journal.origin_version);
    expect(Object.isFrozen(first.journal)).toBe(true);
  });
});
