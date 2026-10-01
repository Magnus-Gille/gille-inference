import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBuildArchive, parseBuildArgs, runBuild } from "../client/m5-build.mjs";

const dirs: string[] = [];
function repo() {
  const root = mkdtempSync(join(tmpdir(), "m5-build-test-")); dirs.push(root);
  const git = (...args: string[]) => { const out=spawnSync("git",["-C",root,...args],{encoding:"utf8"}); if(out.status!==0)throw new Error(out.stderr); return out.stdout; };
  git("init", "-q"); git("config","user.email","test@example.invalid"); git("config","user.name","Test");
  writeFileSync(join(root,"tracked.txt"),"tracked"); git("add","tracked.txt"); git("commit","-qm","initial");
  return {root,git};
}
afterEach(() => { for(const dir of dirs.splice(0)) rmSync(dir,{recursive:true,force:true}); });

describe("local M5 build client", () => {
  it("refuses secret and symlink selections while excluding ignored files", async () => {
    const {root,git}=repo();
    writeFileSync(join(root,"rust-toolchain.toml"),'[toolchain]\nchannel = "1.98.0"\n');
    writeFileSync(join(root,"new.txt"),"untracked");
    writeFileSync(join(root,".env.local"),"never");
    writeFileSync(join(root,"ignored.txt"),"ignore-payload-unique");
    writeFileSync(join(root,".gitignore"),"ignored.txt\n"); git("add",".gitignore");
    symlinkSync("tracked.txt",join(root,"link.txt"));
    await expect(createBuildArchive(root)).rejects.toThrow(/forbidden|unsafe|links/i);
    rmSync(join(root,".env.local")); rmSync(join(root,"link.txt"));
    const archive=await createBuildArchive(root);
    expect(archive.archive.includes(Buffer.from("untracked"))).toBe(true);
    expect(archive.archive.includes(Buffer.from("ignore-payload-unique"))).toBe(false);
    expect(archive.archive.includes(Buffer.from(".git/"))).toBe(false);
  });

  it("uses common-dir and physical worktree identities, and preserves argv after separator", async () => {
    const {root}=repo();
    const linked=mkdtempSync(join(tmpdir(),"m5-worktree-")); dirs.push(linked);
    spawnSync("git",["-C",root,"worktree","add","-q","-b","other",linked]);
    const a=await createBuildArchive(root); const b=await createBuildArchive(linked);
    expect(a.repoId).toBe(b.repoId); expect(a.worktreeId).not.toBe(b.worktreeId);
    expect(parseBuildArgs(["--pull","dist/out.tar","--toolchain","stable","--","echo","--help","--profile","foo"])).toEqual({pull:["dist/out.tar"],toolchain:"stable",command:["echo","--help","--profile","foo"]});
  });

  it("does not load gateway configuration or credentials and propagates worker exit", async () => {
    const {root}=repo(); writeFileSync(join(root,"rust-toolchain.toml"),'[toolchain]\nchannel = "stable"\n');
    const config={version:1,sshTarget:"m5-build"};
    const writes:any[]=[];
    class Stream { write(value:any){writes.push(Buffer.from(value));return true;} }
    const stdout=new Stream(); const stderr=new Stream();
    const fakeSpawn=vi.fn((_command:string,_args:string[],options:any)=>{
      const child:any=new EventEmitter(); child.stdout=new EventEmitter(); child.stderr=new EventEmitter(); child.stdin={write(){},end(){}}; child.kill=()=>{};
      queueMicrotask(()=>{child.stdout.emit("data",Buffer.from(JSON.stringify({type:"stdout",data:Buffer.from("literal").toString("base64")})+"\n"+JSON.stringify({type:"exit",code:7})+"\n"));child.emit("close",7);}); return child;
    });
    const result=await runBuild({cwd:root,command:["echo","--help"],config,spawnImpl:fakeSpawn as any,stdout:stdout as any,stderr:stderr as any});
    expect(result.exit_code).toBe(7); expect(Buffer.concat(writes).toString()).toBe("literal");
    expect(fakeSpawn.mock.calls[0][1]).toContain("m5-build-worker");
    expect(fakeSpawn.mock.calls[0][1]).toContain("BatchMode=yes");
  });

  it("rejects malformed and missing-exit worker streams", async () => {
    const {root}=repo(); writeFileSync(join(root,"rust-toolchain.toml"),'[toolchain]\nchannel = "stable"\n');
    for(const line of ["not-json\n", JSON.stringify({type:"stdout",data:"eA=="})+"\n"]) {
      const fakeSpawn=(_command:string,_args:string[],_options:any)=>{const c:any=new EventEmitter();c.stdout=new EventEmitter();c.stderr=new EventEmitter();c.stdin={write(){},end(){}};c.kill=()=>{};queueMicrotask(()=>{c.stdout.emit("data",Buffer.from(line));c.emit("close",0);});return c;};
      await expect(runBuild({cwd:root,command:["true"],config:{version:1,sshTarget:"m5-build"},spawnImpl:fakeSpawn as any,stdout:{write(){} } as any,stderr:{write(){} } as any})).rejects.toThrow();
    }
  });
});
