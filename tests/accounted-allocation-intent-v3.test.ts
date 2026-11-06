import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {spawn} from "node:child_process";
import {
  AccountedAllocationIntentError,
  digestAccountedAllocationIntentV3,
  openAccountedAllocationIntentLedgerV3,
  planAccountedAllocationLedgerV3Bootstrap,
} from "../src/homeserver/accounted-allocation-intent-v3.js";
import { canonicalNative } from "../src/homeserver/accounted-host-issuer.js";
import {digestOwnerAllocation} from "../contracts/accounted-host-policy-v1/accounted-host-policy.mjs";

const ownerUid = process.getuid!();
const handles: { close(): Promise<void> }[] = [];
const roots: string[] = [];
const signal = () => new AbortController().signal;
const uuid = "11111111-1111-4111-8111-111111111111";
const hostBootId = "22222222-2222-4222-8222-222222222222";
const H = (n: string) => n.repeat(64);
const sha = (domain: string, value: unknown) => createHash("sha256").update(domain + "\n" + canonicalNative(value)).digest("hex");

function accepted(overrides: Record<string, unknown> = {}): any {
  const allocationBody = {
    chargedMemoryMaxBytes: 16 * 1024 * 1024,
    swapMaxBytes: 0,
    cpuQuotaMicros: 1000,
    cpuPeriodMicros: 100000,
    tasksMax: 4,
    addressSpaceLimitBytes: 128 * 1024 * 1024,
  };
  const intent: any = {
    version: 1,
    host_boot_id: hostBootId,
    mandate_id: uuid,
    native_attempt_id: "a".repeat(32),
    request_id: "33333333-3333-4333-8333-333333333333",
    policy_attempt_id: "44444444-4444-4444-8444-444444444444",
    lease_id: H("5"),
    owner_authorization_digest: H("6"),
    owner_allocation: { ...allocationBody, digest: sha("gille-inference/accounted/owner-allocation/v1", allocationBody) },
    brokkr_source_revision: "b".repeat(40),
    brokkr_config_digest: H("7"),
    brokkr_release_digest: H("8"),
    descriptor_digest: "7d97cb1f350f1aaa25b9abfef518f5b8f5b42af77ace1dfa49216692e42f5bde",
    issuer_release_digest: H("9"),
    producer_release_digest: H("a"),
    producer_config_digest: H("b"),
    allocated_from_boottime_ns: "1000000000",
    allocated_until_boottime_ns: "31100000000",
  };
  return { ...intent, ...overrides };
}

async function freshDirectory(): Promise<string> {
  if (ownerUid === 0) throw new Error("unprivileged filesystem test required");
  const path = await fs.mkdtemp(join(await fs.realpath("/tmp"), "accounted-allocation-intent-"));
  await fs.chmod(path, 0o700); roots.push(path); return path;
}

async function seeded(intent = accepted()) {
  const directory = await freshDirectory();
  const bootstrap = planAccountedAllocationLedgerV3Bootstrap(intent.host_boot_id);
  await fs.writeFile(join(directory, "journal.json"), bootstrap.bytes, { mode: 0o600, flag: "wx" });
  const ledger = await openAccountedAllocationIntentLedgerV3({ directory, ownerUid, initialVersion: bootstrap.version, acceptedIntent: intent });
  handles.push(ledger); return { directory, bootstrap, ledger, intent, controller: new AbortController() };
}

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
  for (const path of roots.splice(0)) {
    const stat = await fs.lstat(path);
    if (!stat.isDirectory() || stat.uid !== ownerUid) throw new Error("unsafe test cleanup target");
    await fs.rm(path, { recursive: true });
  }
});

describe("accounted allocation intent ledger v3", () => {
  it("plans a pure closed bootstrap and does not create storage", async () => {
    const plan = planAccountedAllocationLedgerV3Bootstrap(hostBootId);
    expect(plan.state).toEqual({ schemaVersion: 1, kind: "accounted-allocation-intent-ledger", hostBootId, reservation: null });
    expect(plan.bytes).toContain('"reservation":null');
    expect(plan.version).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ["wrong version", { version: true }],
    ["unknown key", { extra: 1 }],
    ["boolean nanoseconds", { allocated_from_boottime_ns: true }],
    ["negative nanoseconds", { allocated_from_boottime_ns: "-1" }],
    ["number nanoseconds", { allocated_from_boottime_ns: 1000000000 }],
    ["leading-zero nanoseconds", { allocated_from_boottime_ns: "01000000000" }],
    ["overflow nanoseconds", { allocated_until_boottime_ns: (2n**63n).toString() }],
    ["unsafe memory", { owner_allocation: { ...accepted().owner_allocation, chargedMemoryMaxBytes: 1 } }],
    ["too long lease", { allocated_until_boottime_ns: "91000000001" }],
  ])("refuses %s before touching a directory", async (_name, change) => {
    const directory = await freshDirectory();
    const bootstrap = planAccountedAllocationLedgerV3Bootstrap(hostBootId);
    await fs.writeFile(join(directory, "journal.json"), bootstrap.bytes, { mode: 0o600, flag: "wx" });
    await expect(openAccountedAllocationIntentLedgerV3({ directory, ownerUid, initialVersion: bootstrap.version, acceptedIntent: accepted(change) })).rejects.toThrow();
    expect(await fs.readFile(join(directory, "journal.json"), "utf8")).toBe(bootstrap.bytes);
  });

  it("refuses an owner allocation digest that does not match its closed body", async () => {
    const intent = accepted(); intent.owner_allocation.digest = H("d");
    await expect(openAccountedAllocationIntentLedgerV3({ directory: await freshDirectory(), ownerUid, initialVersion: H("e"), acceptedIntent: intent })).rejects.toThrow();
  });

  it("accepts the allocation digest produced by the unchanged R4 kernel", () => {
    const intent=accepted();
    intent.owner_allocation.digest=digestOwnerAllocation(intent.owner_allocation);
    expect(digestAccountedAllocationIntentV3(intent)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("persists one reservation and exposes only non-authoritative receipt flags", async () => {
    const f = await seeded();
    const receipt = await f.ledger.reserve(signal());
    expect(receipt).toMatchObject({ status: "reserved", reason: "intent_persisted", attemptConsumed: true, actualAllocationVerified: false, executionAuthorized: false });
    expect(receipt.intentDigest).toBe(digestAccountedAllocationIntentV3(f.intent));
    const view = await f.ledger.read(signal());
    expect(view).toMatchObject({ ledgerRevision: expect.any(String), hostBootId, actualAllocationVerified: false, executionAuthorized: false });
    expect(view.reservation).toEqual({ intent: f.intent, intentDigest: receipt.intentDigest });
    await f.ledger.close(); handles.splice(handles.indexOf(f.ledger), 1);
    const reopened = await openAccountedAllocationIntentLedgerV3({ directory: f.directory, ownerUid, initialVersion: f.bootstrap.version, acceptedIntent: f.intent });
    handles.push(reopened);
    expect((await reopened.read(signal())).reservation?.intentDigest).toBe(receipt.intentDigest);
  });

  it("refuses a duplicate global reservation, including the same lease", async () => {
    const f = await seeded(); expect((await f.ledger.reserve(signal())).status).toBe("reserved");
    const second = await openAccountedAllocationIntentLedgerV3({ directory: f.directory, ownerUid, initialVersion: f.bootstrap.version, acceptedIntent: f.intent }); handles.push(second);
    expect(await second.reserve(signal())).toMatchObject({ status: "refused", reason: "global_reservation_exists", attemptConsumed: true, actualAllocationVerified: false, executionAuthorized: false });
  });

  it("aborts before CAS without adding files", async () => {
    const f = await seeded(), controller = new AbortController(); controller.abort();
    await expect(f.ledger.reserve(controller.signal)).rejects.toThrow();
    expect(await fs.readdir(f.directory)).toEqual(["journal.json"]);
  });

  it("keeps a pre-existing quarantine lock and never resets it", async () => {
    const f = await seeded();
    const lock = join(f.directory, `journal-${f.bootstrap.version}.lock`);
    await fs.writeFile(lock, "quarantine", { mode: 0o600, flag: "wx" });
    await expect(f.ledger.read(signal())).rejects.toMatchObject({code:"journal_quarantined"});
    await expect(f.ledger.reserve(signal())).rejects.toMatchObject({code:"reservation_unresolved",outcome:"unknown",attemptConsumed:true,cause:{code:"journal_quarantined"}});
    expect(await fs.readFile(lock, "utf8")).toBe("quarantine");
  });

  it("allows exactly one winner across two handles and does not retry an uncertain loser", async () => {
    const f = await seeded();
    const rivalIntent=accepted({mandate_id:"55555555-5555-4555-8555-555555555555",native_attempt_id:"c".repeat(32),lease_id:H("c")});
    const second = await openAccountedAllocationIntentLedgerV3({ directory: f.directory, ownerUid, initialVersion: f.bootstrap.version, acceptedIntent: rivalIntent }); handles.push(second);
    const results = await Promise.allSettled([f.ledger.reserve(signal()), second.reserve(signal())]);
    const winners = results.filter(r => r.status === "fulfilled" && r.value.status === "reserved");
    expect(winners).toHaveLength(1);
    const losers = results.filter(r => r.status === "rejected" || (r.status === "fulfilled" && r.value.status === "refused"));
    expect(losers).toHaveLength(1);
    for (const loser of losers) if (loser.status === "rejected") {
      expect(loser.reason).toBeInstanceOf(AccountedAllocationIntentError);
      expect(loser.reason).toMatchObject({code:"reservation_unresolved",outcome:"unknown",attemptConsumed:true});
    }
    const winner=winners[0];
    expect(winner.status).toBe("fulfilled");
    const readback=await f.ledger.read(signal());
    if(winner.status==="fulfilled")expect(readback.reservation?.intentDigest).toBe(winner.value.intentDigest);
  });

  it("has one global winner across two real OS processes with different mandates", async () => {
    const f=await seeded(),identity=await fs.stat(f.directory,{bigint:true});
    const directoryIdentity={device:identity.dev.toString(),inode:identity.ino.toString()};
    const intents=[f.intent,accepted({mandate_id:"77777777-7777-4777-8777-777777777777",lease_id:H("e"),native_attempt_id:"e".repeat(32)})];
    const children=intents.map(intent=>{
      const child=spawn(process.execPath,["--import","tsx","tests/fixtures/accounted-allocation-intent-worker.ts"],
        {cwd:process.cwd(),env:{PATH:"/usr/bin:/bin",HOME:f.directory,TMPDIR:f.directory,ALLOCATION_TEST_DIRECTORY:f.directory},
          stdio:["ignore","pipe","pipe","ipc"],shell:false});
      const messages:any[]=[];let wake:(()=>void)|undefined;
      child.on("message",message=>{messages.push(message);wake?.();});
      const exit=new Promise<number|null>((resolve,reject)=>{child.once("error",reject);child.once("exit",code=>{resolve(code);wake?.();});});
      async function next(){
        if(messages.length===0)await new Promise<void>(resolve=>{wake=resolve;});
        wake=undefined;const message=messages.shift();expect(message).toBeDefined();return message;
      }
      return {child,exit,next,intent};
    });
    try{
      await Promise.all(children.map(async c=>{
        expect(await c.next()).toEqual({phase:"awaiting_request"});
        c.child.send({directory:f.directory,ownerUid,initialVersion:f.bootstrap.version,acceptedIntent:c.intent,directoryIdentity});
        expect(await c.next()).toEqual({phase:"ready",version:f.bootstrap.version,empty:true});
      }));
      children.forEach(c=>c.child.send("go"));
      const results=await Promise.all(children.map(c=>c.next()));
      expect(await Promise.all(children.map(c=>c.exit))).toEqual([0,0]);
      expect(results.every(r=>r.phase==="result")).toBe(true);
      const winners=results.filter(r=>r.receipt.status==="reserved");
      expect(winners).toHaveLength(1);
      const loser=results.find(r=>r.receipt.status!=="reserved")!.receipt;
      expect(["refused","unknown"]).toContain(loser.status);
      if(loser.status==="unknown")expect(loser).toMatchObject({code:"reservation_unresolved",outcome:"unknown",attemptConsumed:true});
      expect((await f.ledger.read(signal())).reservation?.intentDigest).toBe(winners[0].receipt.intentDigest);
    }finally{
      for(const c of children)if(c.child.exitCode===null)c.child.kill("SIGKILL");
      await Promise.all(children.map(c=>c.exit));
    }
  },10000);

  it("pins the accepted static intent before caller mutation", async () => {
    const f=await seeded(),expected=digestAccountedAllocationIntentV3(f.intent);
    f.intent.lease_id=H("d");
    const result=await f.ledger.reserve(signal());
    expect(result.intentDigest).toBe(expected);
    expect((await f.ledger.read(signal())).reservation?.intent.lease_id).toBe(H("5"));
  });

  it("rejects a different physical directory identity even at the same configured path", async () => {
    const f=await seeded(),identity=await fs.stat(f.directory,{bigint:true});
    const trial=openAccountedAllocationIntentLedgerV3({directory:f.directory,ownerUid,initialVersion:f.bootstrap.version,
      acceptedIntent:f.intent,directoryIdentity:{device:identity.dev.toString(),inode:(identity.ino+1n).toString()}} as any)
      .then(async opened=>{await opened.close();return opened;});
    await expect(trial).rejects.toMatchObject({code:"ledger_directory_identity"});
  });

  it("uses a real held directory pin and refuses replacement or adoption at the same path", async () => {
    const f=await seeded(),identity=await fs.stat(f.directory,{bigint:true});
    const directoryIdentity={device:identity.dev.toString(),inode:identity.ino.toString()};
    const opened=await openAccountedAllocationIntentLedgerV3({directory:f.directory,ownerUid,initialVersion:f.bootstrap.version,acceptedIntent:f.intent,directoryIdentity});handles.push(opened);
    expect((await opened.reserve(signal())).status).toBe("reserved");
    const moved=f.directory+"-moved";await fs.rename(f.directory,moved);roots.push(moved);
    await fs.mkdir(f.directory,{mode:0o700});
    await fs.writeFile(join(f.directory,"journal.json"),f.bootstrap.bytes,{mode:0o600,flag:"wx"});
    await expect(opened.read(signal())).rejects.toMatchObject({code:"ledger_directory_identity"});
    await expect(opened.reserve(signal())).rejects.toMatchObject({code:"reservation_unresolved",outcome:"unknown",cause:{code:"ledger_directory_identity"}});
    await expect(openAccountedAllocationIntentLedgerV3({directory:f.directory,ownerUid,initialVersion:f.bootstrap.version,acceptedIntent:f.intent,directoryIdentity})).rejects.toMatchObject({code:"ledger_directory_identity"});
    expect(await fs.readFile(join(f.directory,"journal.json"),"utf8")).toBe(f.bootstrap.bytes);
  });

  it("requires a physical directory pin for the root production path before filesystem access", async () => {
    await expect(openAccountedAllocationIntentLedgerV3({directory:"/var/lib/gille-inference-accounted/allocations",ownerUid:0,initialVersion:H("f"),acceptedIntent:accepted()})).rejects.toMatchObject({code:"ledger_directory_pin_required"});
  });

  it("persists exact nanoseconds beyond the safe Number range as explicit strings", async () => {
    const from=2n**60n,until=from+35000000000n;
    const f=await seeded(accepted({allocated_from_boottime_ns:from.toString(),allocated_until_boottime_ns:until.toString()}));
    expect((await f.ledger.reserve(signal())).status).toBe("reserved");
    const intent=(await f.ledger.read(signal())).reservation!.intent;
    expect(intent.allocated_from_boottime_ns).toBe(from.toString());
    expect(intent.allocated_until_boottime_ns).toBe(until.toString());
  });

  it("does not adopt a different boot epoch or mutate its existing ledger", async () => {
    const f=await seeded(),other=accepted({host_boot_id:"66666666-6666-4666-8666-666666666666"});
    const opened=await openAccountedAllocationIntentLedgerV3({directory:f.directory,ownerUid,initialVersion:f.bootstrap.version,acceptedIntent:other});handles.push(opened);
    await expect(opened.read(signal())).rejects.toMatchObject({code:"ledger_boot_binding"});
    await expect(opened.reserve(signal())).rejects.toMatchObject({code:"reservation_unresolved",outcome:"unknown",attemptConsumed:true});
    expect(await fs.readFile(join(f.directory,"journal.json"),"utf8")).toBe(f.bootstrap.bytes);
    expect(await fs.readdir(f.directory)).toEqual(["journal.json"]);
  });

  it("rejects a root owner configuration outside the fixed global directory before filesystem access", async () => {
    const directory = await freshDirectory();
    await expect(openAccountedAllocationIntentLedgerV3({ directory, ownerUid: 0, initialVersion: H("f"), acceptedIntent: accepted() })).rejects.toMatchObject({ code: "ledger_global_directory" });
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("rejects path traversal and a mismatched owner identity", async () => {
    await expect(openAccountedAllocationIntentLedgerV3({ directory: "/private/tmp/../tmp/accounted", ownerUid, initialVersion: H("1"), acceptedIntent: accepted() })).rejects.toThrow();
    const f = await seeded();
    await expect(openAccountedAllocationIntentLedgerV3({ directory: f.directory, ownerUid: ownerUid + 1, initialVersion: f.bootstrap.version, acceptedIntent: f.intent })).rejects.toThrow();
  });

  it("returns detached reads and refuses operations after close", async () => {
    const f = await seeded(); await f.ledger.reserve(signal());
    const view = await f.ledger.read(signal()); (view.reservation!.intent as any).mandate_id = uuid.replaceAll("1", "2");
    expect((await f.ledger.read(signal())).reservation!.intent.mandate_id).toBe(uuid);
    await f.ledger.close(); handles.splice(handles.indexOf(f.ledger), 1);
    await expect(f.ledger.read(signal())).rejects.toThrow();
  });
});
