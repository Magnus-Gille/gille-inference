import { initDb } from "../../src/db.js";
import { recordReviewerUsefulness } from "../../src/homeserver/ledger.js";

function parseArg(name: string, value: string | undefined): string {
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const [
  rawDbPath,
  rawStartAtMs,
  rawLedgerId,
  rawUsefulness,
  rawJudgedBy,
  rawNotes,
] = process.argv.slice(2);

const dbPath = parseArg("dbPath", rawDbPath);
const startAtMs = Number(parseArg("startAtMs", rawStartAtMs));
const ledgerId = parseArg("ledgerId", rawLedgerId);
const usefulness = parseArg("usefulness", rawUsefulness);
const judgedBy = parseArg("judgedBy", rawJudgedBy);
const notes = rawNotes === "__NULL__" ? null : parseArg("notes", rawNotes);

if (!Number.isFinite(startAtMs)) throw new Error("invalid startAtMs");

initDb(dbPath);

const waitMs = startAtMs - Date.now();
if (waitMs > 0) await sleep(waitMs);

const result = recordReviewerUsefulness({
  ledgerId,
  usefulness: usefulness as "pass" | "partial" | "redo" | "wrong",
  judgedBy,
  notes,
});

process.stdout.write(JSON.stringify(result));
