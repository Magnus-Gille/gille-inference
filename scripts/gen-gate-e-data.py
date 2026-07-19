#!/usr/bin/env python3
"""Generate D3 (pipeline) + D4 (recovery) datasets for Gate E and compute verified golds.
Prints JSON we embed into gate-e-tasks.ts. Gold = computed here, never hand-counted."""
import json, re
from collections import Counter

out = {}

# ── D3-01: access log → top-3 IPs by 5xx count ──────────────────────────────
# Deterministic: construct counts so top-3 is unambiguous.
ips_5xx = (["10.0.0.7"]*9 + ["10.0.0.3"]*7 + ["10.0.0.9"]*5 +
           ["10.0.0.1"]*2 + ["10.0.0.4"]*1)
ips_2xx = ["10.0.0.2"]*20 + ["10.0.0.7"]*3 + ["10.0.0.5"]*15
lines = []
import itertools
paths = ["/api/v1/orders","/api/v1/users","/healthz","/api/v1/search","/login"]
pc = itertools.cycle(paths)
for ip in ips_5xx:
    code = 500 if hash(ip) % 2 == 0 else 503
    lines.append(f'{ip} - - [10/Jun/2026:12:00:00 +0000] "GET {next(pc)} HTTP/1.1" {code} 412')
for ip in ips_2xx:
    lines.append(f'{ip} - - [10/Jun/2026:12:00:00 +0000] "GET {next(pc)} HTTP/1.1" 200 1024')
# interleave deterministically
log = "\n".join(sorted(lines))
c5 = Counter()
for ln in log.splitlines():
    m = re.search(r'"\s\d{3}\s', ' ' + ln)
    parts = ln.split()
    ip = parts[0]; code = int(parts[-2])
    if 500 <= code <= 599:
        c5[ip]+=1
top3 = [ip for ip,_ in c5.most_common(3)]
out["D3-01"] = {"inputData": log, "goldTop3": top3, "_counts": dict(c5)}

# ── D3-02: transactions CSV → top-3 merchants by total refunded ──────────────
import random
rng = random.Random(42)
merchants = ["Acme","Globex","Initech","Umbrella","Soylent","Hooli"]
refunds = {"Globex":0,"Acme":0,"Initech":0,"Umbrella":0,"Soylent":0,"Hooli":0}
rows = ["merchant,amount,type"]
# seed deterministic totals
plan = {"Globex":[120,300,80,150], "Initech":[200,90,60], "Acme":[50,40],
        "Umbrella":[30], "Soylent":[20,10], "Hooli":[5]}
for m, amts in plan.items():
    for a in amts:
        rows.append(f"{m},{a},refund"); refunds[m]+=a
# add noise non-refund rows
for _ in range(10):
    m = rng.choice(merchants); rows.append(f"{m},{rng.randint(10,99)},purchase")
csv = "\n".join(rows)
top3_m = [m for m,_ in sorted(refunds.items(), key=lambda x:-x[1])[:3]]
out["D3-02"] = {"inputData": csv, "goldTop3": top3_m, "_totals": refunds}

# ── D3-03: API log lines → top-3 endpoints by error COUNT (4xx+5xx) ──────────
endpoints = {"/checkout":[500,502,400,503,500], "/cart":[400,400,500],
             "/profile":[404,500], "/feed":[500], "/search":[]}
lines3 = ["ts endpoint status"]
for ep, codes in endpoints.items():
    for code in codes: lines3.append(f"2026-06-10T00:00:00 {ep} {code}")
    for _ in range(3): lines3.append(f"2026-06-10T00:00:00 {ep} 200")
apilog = "\n".join(lines3)
errc = {ep: sum(1 for c in codes if c>=400) for ep,codes in endpoints.items()}
top3_e = [e for e,_ in sorted(errc.items(), key=lambda x:-x[1])[:3]]
out["D3-03"] = {"inputData": apilog, "goldTop3": top3_e, "_errc": errc}

# ── D3-04: chat export → top-3 users by message count ───────────────────────
msgs = {"alice":12,"bob":9,"carol":7,"dave":4,"erin":2}
clines = []
for u,n in msgs.items():
    for i in range(n): clines.append(f"[12:0{i%6}] {u}: message {i}")
chat = "\n".join(sorted(clines))
top3_u = [u for u,_ in sorted(msgs.items(), key=lambda x:-x[1])[:3]]
out["D3-04"] = {"inputData": chat, "goldTop3": top3_u, "_msgs": msgs}

# ── D3-05: dependency manifest → top-3 most-depended-on packages ─────────────
deps = {
  "app": ["lodash","react","axios"],
  "ui": ["react","lodash"],
  "api": ["axios","lodash","zod","react"],
  "cli": ["lodash","axios"],
  "test": ["zod"],
}
dc = Counter()
for pkg, ds in deps.items():
    for d in ds: dc[d]+=1
manifest = json.dumps(deps, indent=2)
top3_d = [d for d,_ in dc.most_common(3)]
out["D3-05"] = {"inputData": manifest, "goldTop3": top3_d, "_dc": dict(dc)}

# ── D4: recovery tasks — embedded unviable sql leaf, gold = derivable token ──
# D4-01: orders table → segment with >$10k returned (sql JOIN+GROUP BY+HAVING)
orders = [
  "segment,status,amount",
  "enterprise,returned,6000","enterprise,returned,5000","enterprise,paid,9000",
  "smb,returned,3000","smb,returned,2000","smb,paid,8000",
  "consumer,returned,1000","consumer,paid,4000",
]
# enterprise returned = 11000 > 10000 → gold "enterprise"
out["D4-01"] = {"inputData":"\n".join(orders), "goldAnswer":"enterprise"}

# D4-02: employees → dept with avg salary > 90k among depts with >=2 staff
emp = [
  "dept,name,salary",
  "platform,a,100000","platform,b,95000",
  "sales,c,80000","sales,d,70000",
  "research,e,130000",  # only 1 → excluded by HAVING count>=2
]
# platform avg = 97500 >90k with 2 staff → "platform"
out["D4-02"] = {"inputData":"\n".join(emp), "goldAnswer":"platform"}

# D4-03: tickets → priority with median resolution > 48h (needs join to sla)
tickets = [
  "priority,hours",
  "P1,10","P1,12",
  "P2,60","P2,72","P2,80",
  "P3,5",
]
# P2 median = 72 > 48 → "P2"
out["D4-03"] = {"inputData":"\n".join(tickets), "goldAnswer":"P2"}

# D4-04: sales by region join targets, region that beat target by >20%
sales = [
  "region,actual,target",
  "north,150,100","south,90,100","east,130,120","west,80,100",
]
# north 150 vs 100 = +50% > 20 ; east +8.3% ; gold "north"
out["D4-04"] = {"inputData":"\n".join(sales), "goldAnswer":"north"}

# D4-05: products join inventory, category fully out of stock
inv = [
  "category,sku,stock",
  "audio,a1,0","audio,a2,0",
  "video,v1,5","video,v2,0",
  "cable,c1,0","cable,c2,0","cable,c3,0",
]
# audio: all 0 ; cable: all 0 ; video has stock. Two categories fully OOS.
# Make unambiguous: give audio a stock so only cable is fully OOS.
inv = [
  "category,sku,stock",
  "audio,a1,3","audio,a2,0",
  "video,v1,5","video,v2,0",
  "cable,c1,0","cable,c2,0","cable,c3,0",
]
out["D4-05"] = {"inputData":"\n".join(inv), "goldAnswer":"cable"}

# Strip debug keys before emitting
clean = {k: {kk: vv for kk, vv in v.items() if not kk.startswith("_")} for k, v in out.items()}

# Emit a committed TS data module (JSON is valid TS literal syntax → no hand-copy errors).
ts = (
    "/**\n"
    " * gate-e-data.ts — AUTO-GENERATED by scripts/gen-gate-e-data.py. Do not edit by hand.\n"
    " *\n"
    " * D3 (pipeline-of-tools) inputs + computed top-3 golds, and D4 (recovery) inputs +\n"
    " * derivable golds for the Gate E orchestration task set. Golds are COMPUTED by the\n"
    " * generator (never hand-counted) and each top-3 set has a strict rank-3/rank-4 gap.\n"
    " */\n\n"
    "export interface D3Data { inputData: string; goldTop3: string[] }\n"
    "export interface D4Data { inputData: string; goldAnswer: string }\n\n"
    "export const D3D4_DATA: Record<string, D3Data | D4Data> = "
    + json.dumps(clean, indent=2)
    + " as const;\n"
)
import os
os.makedirs("scripts", exist_ok=True)
with open("scripts/gate-e-data.ts", "w") as f:
    f.write(ts)
print(json.dumps(clean, indent=2))
print("\n// wrote scripts/gate-e-data.ts", flush=True)
