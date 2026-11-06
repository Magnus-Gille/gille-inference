import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createAccountedIssuerPersistence, canonicalNative } from "../src/homeserver/accounted-host-issuer.js";
import { encodeInitialAccountedIssuerFileRecord, openAccountedIssuerFileStorage } from "../src/homeserver/accounted-issuer-file-storage.js";

const hooks = vi.hoisted(() => ({rename: null as null | ((a: string,b: string) => Promise<void>), sync: null as null | ((path: string) => void), completionRace:false, completionWriteFail:false}));
vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {...actual,
    rename: async (a: any,b: any) => {
      if(hooks.completionRace && String(b).endsWith('.commit')){hooks.completionRace=false;await actual.writeFile(b,'newer-not-ours',{mode:0o600,flag:'wx'});}
      if(hooks.rename) await hooks.rename(String(a),String(b)); return actual.rename(a,b);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      if(hooks.completionRace && String(args[0]).endsWith('.commit') && typeof args[1]==='number' && (args[1]&constants.O_CREAT)) {hooks.completionRace=false;await actual.writeFile(args[0],'newer-not-ours',{mode:0o600,flag:'wx'});}
      const h = await actual.open(...args), sync = h.sync.bind(h);
      const write=h.writeFile.bind(h);h.writeFile=async(...a)=>{if(hooks.completionWriteFail&&String(args[0]).endsWith('.commit'))throw Error('synthetic completion-write failure');return write(...a);};
      h.sync = async () => {hooks.sync?.(String(args[0])); return sync();}; return h;
    },
  };
});
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const H = (s: string) => s.repeat(64);
const ownerUid = process.getuid!();
const owned: {path:string;dev:number;ino:number}[] = [];
const handles: {close():Promise<void>}[] = [];
async function root() {
  if (!ownerUid) throw Error("unprivileged tests only");
  const path = await fs.mkdtemp("/private/tmp/accounted-cas-test-"); await fs.chmod(path,0o700);
  const s = await fs.lstat(path); owned.push({path,dev:s.dev,ino:s.ino}); return path;
}
async function seeded(state: unknown = {value:0}) {
  const directory = await root(), initial = encodeInitialAccountedIssuerFileRecord(state);
  await fs.writeFile(join(directory,"journal.json"),initial.bytes,{mode:0o600,flag:"wx"});
  const options = {directory, ownerUid, initialVersion:initial.version};
  const backend = await openAccountedIssuerFileStorage(options); handles.push(backend);
  return {directory,initial,options,backend,signal:new AbortController().signal};
}
afterEach(async () => {
  hooks.rename=null;hooks.sync=null;hooks.completionRace=false;hooks.completionWriteFail=false;
  for (const h of handles.splice(0)) await h.close();
  for (const r of owned.splice(0)) {
    const s = await fs.lstat(r.path);
    if(s.isSymbolicLink() || s.dev!==r.dev || s.ino!==r.ino || s.uid!==ownerUid) throw Error("refuse cleanup of replaced test root");
    await fs.rm(r.path,{recursive:true});
  }
});
describe("LOCAL physical-file issuer CAS backend", () => {
  it("persists CAS state and a new opaque version through close/reopen", async () => {
    const f=await seeded();const before=await f.backend.storage.read(f.signal);
    expect(before).toEqual({version:f.initial.version,state:{value:0}});
    expect(await f.backend.storage.compareAndSwap(before.version,{value:1},f.signal)).toBe(true);
    await f.backend.close(); const reopened=await openAccountedIssuerFileStorage(f.options);handles.push(reopened);
    const after=await reopened.storage.read(f.signal);expect(after.state).toEqual({value:1});expect(after.version).not.toBe(before.version);
    expect(await reopened.storage.compareAndSwap(before.version,{value:2},f.signal)).toBe(false);
  });
  it("content ABA never revives an earlier version", async () => {
    const f=await seeded();expect(await f.backend.storage.compareAndSwap(f.initial.version,{value:1},f.signal)).toBe(true);
    const middle=await f.backend.storage.read(f.signal);expect(await f.backend.storage.compareAndSwap(middle.version,{value:0},f.signal)).toBe(true);
    const last=await f.backend.storage.read(f.signal);expect(last.state).toEqual({value:0});expect(last.version).not.toBe(f.initial.version);
    expect(await f.backend.storage.compareAndSwap(f.initial.version,{value:99},f.signal)).toBe(false);
  });
  it("rolling the state file back to accepted bootstrap bytes cannot erase completed claims", async()=>{
    const f=await seeded();expect(await f.backend.storage.compareAndSwap(f.initial.version,{value:1},f.signal)).toBe(true);
    await f.backend.close();await fs.writeFile(join(f.directory,'journal.json'),f.initial.bytes);
    await expect(openAccountedIssuerFileStorage(f.options)).rejects.toThrow();
  });
  it("rejects a different bootstrap payload even when otherwise well formed", async()=>{
    const f=await seeded();await f.backend.close();const replacement=encodeInitialAccountedIssuerFileRecord({value:9});
    await fs.writeFile(join(f.directory,'journal.json'),replacement.bytes);await expect(openAccountedIssuerFileStorage(f.options)).rejects.toThrow();
  });
  it("finite revision ceiling refuses before acquiring another lock", async()=>{
    const f=await seeded();await f.backend.close();const raw=JSON.parse(f.initial.bytes);
    Object.assign(raw,{revision:'8192',originVersion:f.initial.version,parentVersion:H('9')});const bytes=canonicalNative(raw),version=sha('gille-inference/accounted/file-journal/v1\n'+bytes);
    await fs.writeFile(join(f.directory,'journal.json'),bytes);const receipt=canonicalNative({schemaVersion:1,originVersion:f.initial.version,oldVersion:H('9'),newVersion:version,revision:'8192'});
    for(const ext of ['lock','commit'])await fs.writeFile(join(f.directory,`journal-${H('9')}.${ext}`),receipt,{mode:0o600,flag:'wx'});
    const reopened=await openAccountedIssuerFileStorage(f.options);handles.push(reopened);const names=await fs.readdir(f.directory);
    await expect(reopened.storage.compareAndSwap(version,{value:1},f.signal)).rejects.toThrow();expect(await fs.readdir(f.directory)).toEqual(names);
  });
  it("never initializes a missing journal", async () => {
    const directory=await root();await expect(openAccountedIssuerFileStorage({directory,ownerUid,initialVersion:H("1")})).rejects.toThrow();
    expect(await fs.readdir(directory)).toEqual([]);
  });
  it.each(["duplicate","malformed","oversize","unknown-version","wrong-origin"])("rejects %s disk state without changing it", async kind=>{
    const f=await seeded();await f.backend.close();
    const raw=kind==="duplicate"?'{"schemaVersion":1,"schemaVersion":1}':kind==="malformed"?'{':kind==="oversize"?'x'.repeat(525000):kind==="unknown-version"?'{}':f.initial.bytes.replace('"0"','"1"');
    await fs.writeFile(join(f.directory,"journal.json"),raw);await expect(openAccountedIssuerFileStorage(f.options)).rejects.toThrow();
    expect(await fs.readFile(join(f.directory,"journal.json"),"utf8")).toBe(raw);
  });
  it.each(["symlink","hardlink","mode"])("refuses an unsafe %s journal", async kind=>{
    const f=await seeded();await f.backend.close();const state=join(f.directory,"journal.json");
    if(kind==="symlink"){await fs.rename(state,join(f.directory,"original"));await fs.symlink("original",state);}
    if(kind==="hardlink")await fs.link(state,join(f.directory,"alias"));
    if(kind==="mode")await fs.chmod(state,0o644);
    await expect(openAccountedIssuerFileStorage(f.options)).rejects.toThrow();
  });
  it("rejects wrong owner and unsafe directory modes", async()=>{
    const f=await seeded();await expect(openAccountedIssuerFileStorage({...f.options,ownerUid:0})).rejects.toThrow();
    await fs.chmod(f.directory,0o777);await expect(f.backend.storage.read(f.signal)).rejects.toThrow();await fs.chmod(f.directory,0o700);
  });
  it("existing crash lock is retained and cannot rearm", async()=>{
    const f=await seeded(),name=`journal-${f.initial.version}.lock`;
    await fs.writeFile(join(f.directory,name),'partial',{mode:0o600,flag:"wx"});
    await expect(f.backend.storage.read(f.signal)).rejects.toThrow();
    await expect(f.backend.storage.compareAndSwap(f.initial.version,{value:1},f.signal)).rejects.toThrow();
    expect(await fs.readFile(join(f.directory,name),"utf8")).toBe('partial');
  });
  it("failure before journal replacement leaves a lock; reopening refuses", async()=>{
    const f=await seeded();hooks.rename=async(_a,b)=>{if(b.endsWith('/journal.json'))throw Error("synthetic disk full");};
    await expect(f.backend.storage.compareAndSwap(f.initial.version,{value:1},f.signal)).rejects.toThrow();hooks.rename=null;
    expect(await fs.readFile(join(f.directory,"journal.json"),"utf8")).toBe(f.initial.bytes);
    await expect(openAccountedIssuerFileStorage(f.options)).rejects.toThrow();
  });
  it("failure after journal rename but before sealed completion never resumes", async()=>{
    const f=await seeded();hooks.completionWriteFail=true;
    await expect(f.backend.storage.compareAndSwap(f.initial.version,{value:1},f.signal)).rejects.toThrow();hooks.completionWriteFail=false;
    expect(await fs.readFile(join(f.directory,"journal.json"),"utf8")).not.toBe(f.initial.bytes);
    await expect(openAccountedIssuerFileStorage(f.options)).rejects.toThrow();
  });
  it("never overwrites a concurrently appearing completion receipt", async()=>{
    const f=await seeded();hooks.completionRace=true;
    await expect(f.backend.storage.compareAndSwap(f.initial.version,{value:1},f.signal)).rejects.toThrow();
    expect(await fs.readFile(join(f.directory,`journal-${f.initial.version}.commit`),'utf8')).toBe('newer-not-ours');
  });
  it("sync failure retains uncertain state and never returns success", async()=>{
    const f=await seeded();hooks.sync=p=>{if(p.endsWith('.tmp'))throw Error("synthetic fsync failure");};
    await expect(f.backend.storage.compareAndSwap(f.initial.version,{value:1},f.signal)).rejects.toThrow();hooks.sync=null;
    await expect(openAccountedIssuerFileStorage(f.options)).rejects.toThrow();
  });
  it("explicit readback reconciles complete bytes after a lost completion sync acknowledgement", async()=>{
    const f=await seeded();hooks.sync=p=>{if(p.endsWith('.commit'))throw Error('lost completion sync receipt');};
    await expect(f.backend.storage.compareAndSwap(f.initial.version,{value:1},f.signal)).rejects.toThrow();hooks.sync=null;await f.backend.close();
    const reopened=await openAccountedIssuerFileStorage(f.options);handles.push(reopened);expect((await reopened.storage.read(f.signal)).state).toEqual({value:1});
    expect(await reopened.storage.compareAndSwap(f.initial.version,{value:2},f.signal)).toBe(false);
    expect((await fs.readdir(f.directory)).filter(n=>n.endsWith('.lock'))).toHaveLength(1);
  });
  it("abort before mutation creates no files and closed handles refuse", async()=>{
    const f=await seeded(), c=new AbortController();c.abort();
    await expect(f.backend.storage.compareAndSwap(f.initial.version,{value:1},c.signal)).rejects.toThrow();
    expect(await fs.readdir(f.directory)).toEqual(['journal.json']);await f.backend.close();await expect(f.backend.storage.read(f.signal)).rejects.toThrow();
  });
  it("rejects a substituted directory and preserves unrelated files", async()=>{
    const f=await seeded(),old=f.directory+'-saved';await fs.rename(f.directory,old);await fs.mkdir(f.directory,{mode:0o700});
    await fs.writeFile(join(f.directory,"unrelated"),'keep',{mode:0o600});
    try {await expect(f.backend.storage.compareAndSwap(f.initial.version,{value:1},f.signal)).rejects.toThrow();expect(await fs.readdir(f.directory)).toEqual(['unrelated']);}
    finally {await fs.unlink(join(f.directory,"unrelated"));await fs.rmdir(f.directory);await fs.rename(old,f.directory);}
  });
  it("cannot publish an admission", async()=>{
    const f=await seeded();await expect(f.backend.storage.publishOnce('a'.repeat(32),'{}','1000',f.signal)).rejects.toThrow();expect(await fs.readdir(f.directory)).toEqual(['journal.json']);
  });
  it("rejects oversized/coercing new state before any file mutation", async()=>{
    const f=await seeded();let hits=0;const value={get input(){hits++;return 1;}};
    await expect(f.backend.storage.compareAndSwap(f.initial.version,value,f.signal)).rejects.toThrow();expect(hits).toBe(0);
    await expect(f.backend.storage.compareAndSwap(f.initial.version,{value:'x'.repeat(524289)},f.signal)).rejects.toThrow();expect(await fs.readdir(f.directory)).toEqual(['journal.json']);
  });
  it("physical persisted reservation still blocks reuse through a fresh issuer instance", async()=>{
    const state={schemaVersion:1,hostBootIdSha256:H('1'),observerInstanceSha256:H('2'),lastSequence:0,seenEvidenceDigests:[],seenAttempts:[],claims:[]};
    const f=await seeded(state),binding={challengeDigest:H('3'),requestDigest:H('4'),nativeAttemptId:'a'.repeat(32),requestId:'11111111-1111-4111-8111-111111111111',policyAttemptId:'22222222-2222-4222-8222-222222222222',issuerReleaseDigest:H('5')};
    expect(await createAccountedIssuerPersistence(f.backend.storage).reserve(binding,f.signal)).not.toBeNull();await f.backend.close();
    const reopened=await openAccountedIssuerFileStorage(f.options);handles.push(reopened);expect(await createAccountedIssuerPersistence(reopened.storage).reserve(binding,f.signal)).toBeNull();
  });
  it("two bounded real child processes have exactly one CAS winner", async()=>{
    const f=await seeded();await f.backend.close();
    const run=(value:number)=>new Promise<any>((resolve,reject)=>{
      const child=spawn(process.execPath,['--import','tsx','tests/fixtures/accounted-issuer-file-storage-worker.ts'],{cwd:process.cwd(),env:{PATH:'/usr/bin:/bin',HOME:f.directory,TMPDIR:f.directory,ISSUER_TEST_DIRECTORY:f.directory},stdio:['pipe','pipe','pipe'],shell:false});
      const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('owned child deadline'));},5000);let output='';let stderrBytes=0;
      child.stdout.on('data',b=>{output+=b.toString();if(output.length>4096)child.kill('SIGKILL');});child.stderr.on('data',b=>{stderrBytes+=b.length;if(stderrBytes>8192)child.kill('SIGKILL');});
      child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('close',code=>{clearTimeout(timer);try{resolve({code,result:JSON.parse(output)});}catch{reject(Error('child invalid bounded result'));}});
      child.stdin.end(JSON.stringify({action:'cas',directory:f.directory,ownerUid,initialVersion:f.initial.version,expectedVersion:f.initial.version,state:{value}}));
    });
    const results=await Promise.all([run(1),run(2)]);expect(results.filter(x=>x.result.status==='cas'&&x.result.won===true)).toHaveLength(1);
    const reopened=await openAccountedIssuerFileStorage(f.options);handles.push(reopened);expect([1,2]).toContain(((await reopened.storage.read(f.signal)).state as {value:number}).value);
  });
});
