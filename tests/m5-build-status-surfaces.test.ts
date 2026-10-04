import { describe, expect, it, vi } from "vitest";
import { main } from "../client/m5.mjs";
import { createMcpStdioBridge } from "../client/m5-stdio-bridge.mjs";
const capacity = { total_bytes: 64 * 1024 ** 3, used_bytes: 63 * 1024 ** 3, free_bytes: 1024 ** 3,
  minimum_free_bytes: 1024 ** 3, warning_free_bytes: 8 * 1024 ** 3, observed_at: "2026-10-04T07:00:00Z" };
function sink() { let text = ""; return { write(v: string) { text += v; return true; }, text: () => text }; }
describe("read-only build capacity surfaces", () => {
 it("CLI status does not require a worktree, gateway config or credentials", async () => {
  const output = sink(), error = sink(); const status = vi.fn(async () => capacity);
  const result = await main(["build", "status"], { output, error, buildStatusRunner: status,
   configLoader() { throw Error("must not read gateway config"); }, credentialStore: { resolve() { throw Error("must not read credentials"); } },
   buildRunner() { throw Error("must not start build"); } } as any);
  expect(result).toBe(0); expect(status).toHaveBeenCalledOnce(); expect(JSON.parse(output.text())).toEqual(capacity);
 });
 it("CLI status rejects extra arguments before any transport", async () => {
  const status = vi.fn(); const result=await main(["build","status","--cleanup"],{ output:sink(),error:sink(),buildStatusRunner:status } as any);
  expect(result).toBe(125); expect(status).not.toHaveBeenCalled();
 });
 it("MCP status is local and rejects parameters", async () => {
  const rpc=vi.fn(); const status=vi.fn(async()=>capacity);
  const bridge=createMcpStdioBridge({client:{rpc},buildConfig:{sshTarget:"m5-build"},buildStatusRunner:status} as any);
  const result=JSON.parse((await bridge.handleLine(JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"build_status",arguments:{}}})))!);
  expect(result.result.isError).toBe(false); expect(JSON.parse(result.result.content[0].text)).toEqual(capacity); expect(rpc).not.toHaveBeenCalled();
  const refused=JSON.parse((await bridge.handleLine(JSON.stringify({jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"build_status",arguments:{cleanup:true}}})))!);
  expect(refused.error).toBeDefined(); expect(status).toHaveBeenCalledOnce();
 });
 it("MCP only advertises status when local builds are configured", async () => {
  const make=()=>({rpc:vi.fn(async()=>({jsonrpc:"2.0",id:1,result:{tools:[]}}))});
  for (const configured of [true,false]) {
   const bridge=createMcpStdioBridge({client:make(),...(configured?{buildConfig:{sshTarget:"m5-build"}}:{})} as any);
   const response=JSON.parse((await bridge.handleLine(JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list"})))!);
   expect(response.result.tools.some((t:any)=>t.name==="build_status")).toBe(configured);
  }
 });
});
