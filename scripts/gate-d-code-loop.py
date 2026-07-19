#!/usr/bin/env python3
"""Gate D acceptance battery THROUGH code_loop (r1: >=9/10 before routine use).

Default enumeration is the pinned r1 corpus. Fresh r2 holdouts require the explicit
``--include-holdout`` flag or ``GATE_D_INCLUDE_HOLDOUT=1``. For each selected task:
seed files -> code_loop_start -> poll -> fetch diff ->
apply onto a pristine seed copy (own git root, run.sh discipline) -> grade with
the battery's own deterministic check.sh (no model in grading). Resumable via JSONL.
"""
import argparse, json, os, re, shutil, subprocess, sys, time, urllib.request

REPO = os.environ.get("GATE_D_CL_REPO", "/srv/gille-inference")
GW = os.environ.get("GATE_D_CL_GATEWAY", "http://192.0.2.10:8080/mcp")
TASKS = os.path.join(REPO, "gate-d", "tasks")
CHECK = os.path.join(REPO, "gate-d", "check.sh")
WORKROOT = os.path.join(REPO, "gate-d", ".work-cl")  # INSIDE the repo: check.sh npx --no-install walks up to node_modules (run.sh lesson)
RESULTS = os.environ.get("GATE_D_CL_RESULTS", os.path.join(REPO, "data", "gate-d-cl-results.jsonl"))
POLL_S, DEADLINE_S, WALL_S = 10, 720, 600

sys.path.insert(0, os.path.join(REPO, "gate-d"))
from gate_d_corpus import (  # noqa: E402
    active_revision,
    include_holdout_from_env,
    load_manifest,
    revision_contract,
    task_metadata,
)

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("task", nargs="?", help="one task id from the selected corpus")
parser.add_argument("--include-holdout", action="store_true", help="select gate-d-r2 (burns fresh holdouts)")
parser.add_argument("--list-tasks", action="store_true", help="print the selected revision contract without credentials or inference")
parser.add_argument("--scoreboard-only", action="store_true", help="score existing selected-revision rows without credentials or inference")
args = parser.parse_args()
include_holdout = args.include_holdout or include_holdout_from_env()
manifest = load_manifest()
corpus_revision = active_revision(manifest, include_holdout)
contract = revision_contract(manifest, corpus_revision)
task_ids = list(contract["tasks"])
acceptance = contract["acceptance"]
only = args.task
if only is not None and only not in task_ids:
    if os.path.isfile(os.path.join(TASKS, only, "meta.json")):
        parser.error(f"task {only!r} is not in {corpus_revision}; holdouts require --include-holdout")
    parser.error(f"unknown Gate D task {only!r}")
if args.list_tasks:
    print(json.dumps({
        "corpusRevision": corpus_revision,
        "tasks": task_ids,
        "holdoutTasks": contract.get("holdoutTasks", []),
        "acceptance": acceptance,
    }, sort_keys=True))
    raise SystemExit(0)


def scoreboard_summary():
    latest = {}
    if os.path.exists(RESULTS):
        with open(RESULTS) as handle:
            for line in handle:
                if not line.strip():
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                row_revision = row.get("corpusRevision", "gate-d-r1")
                if row_revision == corpus_revision and row.get("id") in task_ids:
                    latest[row["id"]] = row
    denominator = acceptance["denominator"]
    minimum_pass = acceptance["minimumPass"]
    if denominator != len(task_ids):
        raise RuntimeError(f"{corpus_revision} denominator {denominator} != {len(task_ids)} selected tasks")
    npass = sum(1 for row in latest.values() if row.get("passed"))
    complete = len(latest)
    verdict = "PASS" if complete == denominator and npass >= minimum_pass else "FAIL"
    return {
        "corpusRevision": corpus_revision,
        "passed": npass,
        "completed": complete,
        "minimumPass": minimum_pass,
        "denominator": denominator,
        "verdict": verdict,
        "rows": latest,
    }


def print_scoreboard():
    summary = scoreboard_summary()
    print(f"\n=== GATE D THROUGH code_loop [{corpus_revision}]: {summary['passed']}/{summary['denominator']} "
          f"(completed {summary['completed']}/{summary['denominator']}; "
          f"acceptance >= {summary['minimumPass']}/{summary['denominator']}) => {summary['verdict']} ===", flush=True)
    for tid in task_ids:
        row = summary["rows"].get(tid)
        if row is None:
            print(f"  {tid}: MISSING", flush=True)
            continue
        print(f"  {tid}: {'PASS' if row.get('passed') else 'FAIL ' + str(row.get('check_tail', ''))[-80:]}", flush=True)
    print("SCOREBOARD_JSON=" + json.dumps({key: value for key, value in summary.items() if key != "rows"}, sort_keys=True), flush=True)
    return 0 if summary["verdict"] == "PASS" else 1


if args.scoreboard_only:
    raise SystemExit(print_scoreboard())

with open(os.path.expanduser("~/.scout-maintenance.env")) as f:
    KEY = re.search(r"hs_owner_[A-Za-z0-9_-]+", f.read()).group(0)

def mcp(tool, args):
    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": tool, "arguments": args}}
    req = urllib.request.Request(GW, data=json.dumps(body).encode(),
                                 headers={"Authorization": "Bearer " + KEY,
                                          "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(json.load(r)["result"]["content"][0]["text"])

def sh(argv, cwd=None):
    return subprocess.run(argv, cwd=cwd, capture_output=True, text=True, timeout=300)

def seed_files(repo_dir):
    out = []
    for root, _dirs, names in os.walk(repo_dir):
        for n in sorted(names):
            p = os.path.join(root, n)
            out.append({"path": os.path.relpath(p, repo_dir),
                        "content": open(p, encoding="utf-8").read()})
    return out

done = set()
if os.path.exists(RESULTS):
    with open(RESULTS) as f:
        for line in f:
            if not line.strip():
                continue
            try:
                prior = json.loads(line)
            except json.JSONDecodeError:
                continue
            prior_revision = prior.get("corpusRevision", "gate-d-r1")
            if prior_revision == corpus_revision and prior.get("id") in task_ids:
                done.add(prior["id"])

for tid in task_ids:
    if only and tid != only:
        continue
    if tid in done:
        print(f"[{tid}] already done — skip", flush=True)
        continue
    tdir = os.path.join(TASKS, tid)
    instr = open(os.path.join(tdir, "INSTRUCTION.md"), encoding="utf-8").read()
    files = seed_files(os.path.join(tdir, "repo"))
    task_meta = task_metadata(tid)
    row = {
        "id": tid,
        "corpusRevision": corpus_revision,
        "taskRevision": task_meta["taskRevision"],
        "holdout": task_meta["holdout"],
        "n_seed_files": len(files),
    }
    t0 = time.time()
    try:
        start = mcp("code_loop_start", {"instruction": instr, "files": files,
                                        "caps": {"wall_s": WALL_S}})
    except Exception as e:
        start = {"refusal": "transport", "message": str(e)[:200]}
    if "work_id" not in start:
        row.update(status="start-refused", detail=json.dumps(start)[:300],
                   passed=False, wall_s=round(time.time() - t0, 1))
        print(f"[{tid}] START REFUSED: {row['detail']}", flush=True)
        with open(RESULTS, "a") as f:
            f.write(json.dumps(row) + "\n")
        continue
    wid = start["work_id"]
    status = "running"
    while time.time() - t0 < DEADLINE_S:
        time.sleep(POLL_S)
        try:
            status = mcp("code_loop_status", {"work_id": wid}).get("status", "?")
        except Exception:
            status = "?"
        if status not in ("running", "?"):
            break
    res = mcp("code_loop_result", {"work_id": wid})
    row.update(status=res.get("status"), usage=res.get("usage"),
               detail=(res.get("detail") or "")[:200],
               summary=(res.get("summary") or "")[:150])
    # grade: pristine seed copy + own git root (run.sh discipline) + apply + check.sh
    wdir = os.path.join(WORKROOT, tid)
    shutil.rmtree(wdir, ignore_errors=True)
    shutil.copytree(os.path.join(tdir, "repo"), wdir)
    for c in (["git", "init", "-q", "."], ["git", "add", "-A"],
              ["git", "-c", "user.email=g@d", "-c", "user.name=gd", "commit", "-qm", "seed"]):
        sh(c, cwd=wdir)
    diff = res.get("diff") or ""
    if diff.strip():
        dpath = os.path.join(wdir, ".cl.patch")
        open(dpath, "w").write(diff)
        ap = sh(["git", "apply", "--whitespace=nowarn", ".cl.patch"], cwd=wdir)
        os.remove(dpath)
        row["applied"] = ap.returncode == 0
        if ap.returncode != 0:
            row["apply_err"] = (ap.stderr or "")[:200]
    else:
        row["applied"] = False
        row["apply_err"] = "empty diff"
    chk = sh(["bash", CHECK, tdir, wdir])
    row["check_exit"] = chk.returncode
    row["check_tail"] = ((chk.stdout or "") + (chk.stderr or ""))[-300:]
    row["passed"] = row.get("applied", False) and chk.returncode == 0
    row["wall_s"] = round(time.time() - t0, 1)
    print(f"[{tid}] {'PASS' if row['passed'] else 'FAIL'} "
          f"(loop={row['status']}, check_exit={row['check_exit']}, {row['wall_s']}s)", flush=True)
    with open(RESULTS, "a") as f:
        f.write(json.dumps(row) + "\n")

# scoreboard
if not only:
    raise SystemExit(print_scoreboard())
