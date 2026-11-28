#!/usr/bin/env python3
"""Gate D acceptance battery THROUGH code_loop (r1: >=9/10 before routine use).

Default enumeration is the pinned r1 corpus. Fresh r2 holdouts require the explicit
``--include-holdout`` flag or ``GATE_D_INCLUDE_HOLDOUT=1``. For each selected task:
seed files -> code_loop_start -> poll -> fetch diff ->
apply onto a pristine seed copy (own git root, run.sh discipline) -> grade with
the battery's own deterministic check.sh (no model in grading). Resumable via JSONL.

``--tasks-root DIR`` (or ``GATE_D_TASKS_ROOT``) selects an external corpus instead (INFER-521):
the tasks in DIR/corpus-manifest.json, digest-checked before submission and after grading (a
mismatch aborts without a row), sealed tasks only with the holdout opt-in, and rows carrying the
r3 identity plus the at-stop verification fields. External corpora have no acceptance gate here,
so the scoreboard reports pass counts without a verdict. The manifest is read once and kept in
memory for the whole run. Unlike run.sh, this runner grades in a work dir inside the checkout
(WORKROOT below): the arm runs remotely in the gateway and only grading happens here, so the #172
escape path (a local harness walking up into the checkout) does not exist.
"""
import argparse, json, os, re, shutil, subprocess, sys, time, urllib.request
from pathlib import Path

# Physical and absolute: check.sh's G0-toolchain gate compares the node_modules link with the
# physical checkout path, so an alias such as "." or a symlink would fail every task.
# Defaults to the checkout holding this script (/srv/gille-inference, the old default, does not
# exist on the box); GATE_D_CL_REPO still overrides it.
REPO = os.path.realpath(os.environ.get("GATE_D_CL_REPO", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")))
GW = os.environ.get("GATE_D_CL_GATEWAY", "http://192.0.2.10:8080/mcp")
TASKS = os.path.join(REPO, "gate-d", "tasks")
CHECK = os.path.join(REPO, "gate-d", "check.sh")
WORKROOT = os.path.join(REPO, "gate-d", ".work-cl")  # INSIDE the repo: check.sh npx --no-install walks up to node_modules (run.sh lesson)
RESULTS = os.environ.get("GATE_D_CL_RESULTS", os.path.join(REPO, "data", "gate-d-cl-results.jsonl"))
POLL_S, DEADLINE_S, WALL_S = 10, 720, 600

sys.path.insert(0, os.path.join(REPO, "gate-d"))
from gate_d_corpus import (  # noqa: E402
    ExternalCorpusError,
    _is_holdout,
    _read_meta,
    external_root,
    scope_violations,
    external_tasks,
    load_external_manifest,
    verify_external_task,
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
parser.add_argument("--tasks-root", default=os.environ.get("GATE_D_TASKS_ROOT"),
                    help="external corpus with corpus-manifest.json (INFER-521); default $GATE_D_TASKS_ROOT")
args = parser.parse_args()
include_holdout = args.include_holdout or include_holdout_from_env()
external = args.tasks_root is not None
task_revisions = {}
task_holdout = {}
if external:
    try:
        TASKS = str(external_root(args.tasks_root, Path(REPO)))
        ext_manifest = load_external_manifest(Path(TASKS))
        task_ids = external_tasks(Path(TASKS), ext_manifest, include_holdout)
    except (ExternalCorpusError, OSError) as error:
        parser.error(str(error))
    if not task_ids:
        parser.error(f"{TASKS} has no runnable tasks; sealed tasks require --include-holdout")
    corpus_revision = ext_manifest["corpusRevision"]
    task_revisions = {t["id"]: t["digest"] for t in ext_manifest["tasks"]}
    # Effective sealing per task: identical bytes can be validation in one manifest and sealed in
    # another, so resume must never count a validation row toward a sealed run.
    try:
        task_holdout = {e["id"]: _is_holdout(ext_manifest, _read_meta(Path(TASKS) / e["id"]))
                        for e in ext_manifest["tasks"]}
    except (ExternalCorpusError, OSError) as error:
        parser.error(str(error))
    contract = {"tasks": task_ids}
    acceptance = {"minimumPass": None, "denominator": len(task_ids)}
else:
    manifest = load_manifest()
    corpus_revision = active_revision(manifest, include_holdout)
    contract = revision_contract(manifest, corpus_revision)
    task_ids = list(contract["tasks"])
    acceptance = contract["acceptance"]
only = args.task
if only is not None and only not in task_ids:
    if external and only in task_revisions:
        parser.error(f"task {only!r} is sealed; holdouts require --include-holdout")
    if not external and os.path.isfile(os.path.join(TASKS, only, "meta.json")):
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


def current_row(row):
    """A row counts for this run's corpus: same revision, a selected task, and (external) same digest."""
    if row.get("corpusRevision", "gate-d-r1") != corpus_revision or row.get("id") not in task_ids:
        return False
    # A gate that could not run is a runner failure: keep the row as a diagnostic, but it neither
    # completes the task for resume nor enters the score (as gate-d/sweep.sh does for R3-io-error).
    if row.get("io_gate") == "R3-io-error":
        return False
    return not external or (row.get("taskRevision") == task_revisions.get(row.get("id"))
                            and row.get("holdout") == task_holdout.get(row.get("id")))


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
                if row_revision == corpus_revision and current_row(row):
                    latest[row["id"]] = row
    denominator = acceptance["denominator"]
    minimum_pass = acceptance["minimumPass"]
    if denominator != len(task_ids):
        raise RuntimeError(f"{corpus_revision} denominator {denominator} != {len(task_ids)} selected tasks")
    npass = sum(1 for row in latest.values() if row.get("passed"))
    complete = len(latest)
    if minimum_pass is None:
        verdict = "REPORT"  # external corpus: measurement only, no acceptance gate
    else:
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
          f"(completed {summary['completed']}/{summary['denominator']}; " +
          (f"acceptance >= {summary['minimumPass']}/{summary['denominator']}" if summary['minimumPass'] is not None else "no acceptance gate")
          + f") => {summary['verdict']} ===", flush=True)
    for tid in task_ids:
        row = summary["rows"].get(tid)
        if row is None:
            print(f"  {tid}: MISSING", flush=True)
            continue
        print(f"  {tid}: {'PASS' if row.get('passed') else 'FAIL ' + str(row.get('check_tail', ''))[-80:]}", flush=True)
    print("SCOREBOARD_JSON=" + json.dumps({key: value for key, value in summary.items() if key != "rows"}, sort_keys=True), flush=True)
    return 0 if summary["verdict"] in ("PASS", "REPORT") else 1


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

# Runner configuration never reaches candidate code (at-stop's visible tests, check.sh's oracle):
# GATE_D_TASKS_ROOT names the directory holding every task's oracle/ and solution/.
CHILD_ENV = {k: v for k, v in os.environ.items() if not k.startswith("GATE_D_")}


def sh(argv, cwd=None):
    return subprocess.run(argv, cwd=cwd, capture_output=True, text=True, timeout=300, env=CHILD_ENV)

AT_STOP = os.path.join(REPO, "gate-d", "at-stop.sh")
IO_GATE = os.path.join(REPO, "vendor", "code-battle-gate-d-r3", "io-gate.mjs")
# check.sh for external corpora, as gate-d/run.sh runs it (INFER-521): no code generation from
# strings and no tsx cache in any node process it starts.
HARDENED_ENV = dict(CHILD_ENV, TSX_DISABLE_CACHE="1", NODE_OPTIONS=" ".join(
    x for x in ("--disallow-code-generation-from-strings", CHILD_ENV.get("NODE_OPTIONS", "")) if x))


def io_gate(tdir, wdir):
    """Gate R3-io (code-battle gate-d-r3 io-gate.mjs), static and non-executing: "pass", "R3-io" for a
    violation (a model outcome) or "R3-io-error" when the gate itself cannot run (a runner failure)."""
    try:
        res = subprocess.run(["node", IO_GATE, os.path.join(REPO, "node_modules"), os.path.join(tdir, "repo"), wdir],
                             capture_output=True, text=True, timeout=300, stdin=subprocess.DEVNULL, env=CHILD_ENV)
    except (OSError, subprocess.SubprocessError):
        return "R3-io-error", ""
    if res.returncode == 0:
        return "pass", ""
    if res.returncode == 1 and any(l.startswith("FAIL[R3-io]") for l in res.stdout.splitlines()):
        return "R3-io", res.stdout
    return "R3-io-error", res.stdout + res.stderr
AT_STOP_SPEC = {
    "atStopTypecheck": ("passed", "failed"),
    "atStopVisibleTests": ("passed", "failed", "none"),
    "detectableFailureAtStop": (True, False),
}


NULL_AT_STOP = {key: None for key in AT_STOP_SPEC}


def at_stop(tdir, wdir):
    """Grader-derived verification fields (INFER-521); fails open to nulls, never affects pass/fail."""
    parsed = {}
    # First the non-executing scope check (check.sh's G0-files allowlist): a patch that grading will
    # reject, such as a rewritten package.json test script, is never executed here. Then a
    # throwaway copy, so files a candidate's visible tests leave behind never reach check.sh, run with a
    # minimal environment: no inherited credentials and a throwaway HOME (Codex review, INFER-521).
    try:
        out_of_scope = scope_violations(Path(tdir), Path(wdir))
    except (ValueError, OSError):
        out_of_scope = ["<unreadable>"]
    if out_of_scope:
        print("  [warn] out-of-scope changes; at-stop.sh not run and its fields are null", flush=True)
        return dict(NULL_AT_STOP)
    scratch, home = f"{wdir}.atstop", f"{wdir}.atstop-home"
    try:
        for d in (scratch, home):
            shutil.rmtree(d, ignore_errors=True)
        shutil.copytree(wdir, scratch, symlinks=True)
        os.mkdir(home, 0o700)
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": home, "TMPDIR": home,
               "LANG": os.environ.get("LANG", "C"), "AT_STOP_CAP_S": os.environ.get("AT_STOP_CAP_S", "120"),
               # Named explicitly, never taken from the candidate-controlled node_modules link.
               "AT_STOP_TOOLCHAIN": os.path.join(REPO, "node_modules"),
               "NODE_OPTIONS": "--disallow-code-generation-from-strings", "TSX_DISABLE_CACHE": "1"}
        res = subprocess.run(["bash", AT_STOP, tdir, scratch], cwd=scratch, capture_output=True, text=True,
                             timeout=300, stdin=subprocess.DEVNULL, env=env)
        if res.returncode == 0:
            parsed = json.loads(res.stdout.strip() or "{}")
    except (OSError, subprocess.SubprocessError, ValueError, shutil.Error):
        parsed = {}
    finally:
        for d in (scratch, home):
            shutil.rmtree(d, ignore_errors=True)
    if not parsed:
        print("  [warn] at-stop.sh failed, timed out or printed nothing; at-stop fields are null", flush=True)
    if not isinstance(parsed, dict):
        parsed = {}
    out = {}
    for key, allowed in AT_STOP_SPEC.items():
        value = parsed.get(key)
        ok = isinstance(value, bool) if key == "detectableFailureAtStop" else value in allowed
        out[key] = value if ok else None
    return out


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
            if prior_revision == corpus_revision and current_row(prior):
                done.add(prior["id"])

for tid in task_ids:
    if only and tid != only:
        continue
    if tid in done:
        print(f"[{tid}] already done — skip", flush=True)
        continue
    tdir = os.path.join(TASKS, tid)
    if external:
        try:
            task_meta = verify_external_task(Path(TASKS), ext_manifest, tid, include_holdout)
        except (ExternalCorpusError, OSError) as error:
            print(f"FATAL[{tid}]: the external task failed its manifest check; no row written: {error}", file=sys.stderr)
            raise SystemExit(9)
    else:
        task_meta = task_metadata(tid)
    instr = open(os.path.join(tdir, "INSTRUCTION.md"), encoding="utf-8").read()
    files = seed_files(os.path.join(tdir, "repo"))
    row = {
        "id": tid,
        "corpusRevision": corpus_revision,
        "taskRevision": task_meta["taskRevision"],
        "holdout": task_meta["holdout"],
        "n_seed_files": len(files),
    }
    if external:
        row.update({k: task_meta.get(k) for k in ("family", "split", "trap")})
        row.update(NULL_AT_STOP, io_gate=None)  # stable schema, also on start-refused rows
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
    if external:
        # Re-verify before grading reads the task (seed copy, oracle, structural check): a task
        # regenerated while the remote loop ran must never be graded at all (Codex review).
        try:
            if verify_external_task(Path(TASKS), ext_manifest, tid, include_holdout) != task_meta:
                raise ExternalCorpusError("its identity differs from the one recorded before submission")
        except (ExternalCorpusError, OSError) as error:
            print(f"FATAL[{tid}]: the external task changed while the code loop ran; not graded, no row written: {error}",
                  file=sys.stderr)
            raise SystemExit(9)
    # grade: pristine seed copy + own git root (run.sh discipline) + apply + check.sh
    wdir = os.path.join(WORKROOT, tid)
    shutil.rmtree(wdir, ignore_errors=True)
    shutil.copytree(os.path.join(tdir, "repo"), wdir)
    # check.sh's G0-toolchain gate requires the harness-owned node_modules link (run.sh does the same).
    os.symlink(os.path.join(REPO, "node_modules"), os.path.join(wdir, "node_modules"))
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
    # External corpora: a row passes only if gate R3-io AND check.sh pass (see gate-d/run.sh). The
    # static gate runs first, so no candidate code (at-stop's visible tests included) executes for a
    # workspace whose modules could reach files, processes or the module loader.
    io_verdict, io_out = io_gate(tdir, wdir) if external else ("pass", "")
    if external:
        row["io_gate"] = io_verdict
        if io_verdict == "pass":
            row.update(at_stop(tdir, wdir))  # before check.sh stages the hidden oracle
        else:
            print(f"  [warn] gate {io_verdict}; at-stop.sh not run and its fields are null", flush=True)
    if io_verdict != "pass":
        row["check_exit"] = None
        row["check_tail"] = io_out[-300:]
        row["passed"] = False
    else:
        chk = subprocess.run(["bash", CHECK, tdir, wdir], capture_output=True, text=True, timeout=300,
                             env=HARDENED_ENV if external else CHILD_ENV)
        row["check_exit"] = chk.returncode
        row["check_tail"] = ((chk.stdout or "") + (chk.stderr or ""))[-300:]
        row["passed"] = row.get("applied", False) and chk.returncode == 0
    row["wall_s"] = round(time.time() - t0, 1)
    if external:
        try:
            if verify_external_task(Path(TASKS), ext_manifest, tid, include_holdout) != task_meta:
                raise ExternalCorpusError("its identity differs from the one recorded before the run")
        except (ExternalCorpusError, OSError) as error:
            print(f"FATAL[{tid}]: the external task changed during the run; no row written: {error}", file=sys.stderr)
            raise SystemExit(9)
    print(f"[{tid}] {'PASS' if row['passed'] else 'FAIL'} "
          f"(loop={row['status']}, check_exit={row['check_exit']}, {row['wall_s']}s)", flush=True)
    with open(RESULTS, "a") as f:
        f.write(json.dumps(row) + "\n")

# scoreboard
if not only:
    raise SystemExit(print_scoreboard())
