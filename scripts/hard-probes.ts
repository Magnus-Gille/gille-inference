/**
 * hard-probes.ts — a HARDER leaf-task battery for the cascade-gate experiment.
 *
 * The standard probes (probes.ts) are calibrated to mellum's competence — it passes ~37/38,
 * giving the escalation experiment only ~1 failure (no statistical power). These are
 * self-contained, deterministically-verifiable tasks at a small code model's weak spots
 * (multi-step arithmetic, date/calendar reasoning, unit/base conversion, logic, counting) so
 * the primary model fails often enough to actually test the disagreement gate.
 *
 * Golds are computed inline in comments so they're auditable. Each prompt asks for an
 * `ANSWER: <value>` final line; verifiers extract after the last tag (robust to reasoning).
 */
import type { Probe } from "../src/homeserver/probes.js";
import type { Verifier } from "../src/homeserver/verifier.js";

function afterTag(out: string): string {
  const up = out.toUpperCase();
  const idx = up.lastIndexOf("ANSWER:");
  return (idx >= 0 ? out.slice(idx + "ANSWER:".length) : out).trim();
}
function lastNumber(s: string): number | null {
  const m = s.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/g);
  return m && m.length ? parseFloat(m[m.length - 1]!) : null;
}
function norm(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
/** Numeric answer (tolerance), extracted from the ANSWER: tag (or last number). */
function numAns(expected: number, tol = 1e-6): Verifier {
  return (out: string) => {
    const v = lastNumber(afterTag(out));
    const ok = v !== null && Math.abs(v - expected) <= tol;
    return { outcome: ok ? "pass" : "fail", score: ok ? 1 : 0 };
  };
}
/** Ordinal answer: accept the number, its ordinal ("2"/"2nd"), or word forms ("second"),
 *  and reject the wrong-but-tempting one (e.g. "1st"/"first") to avoid false passes. */
export function ordinalAns(n: number, words: string[]): Verifier {
  const wordRe = words.length ? `|${words.map((w) => w.replace(/[^\p{L}]/gu, "")).join("|")}` : "";
  const ok = new RegExp(`\\b(${n}|${n}st|${n}nd|${n}rd|${n}th${wordRe})\\b`, "i");
  const wrong = new RegExp(`\\b(${n - 1}|${n - 1}st|${n - 1}nd|${n - 1}rd|${n - 1}th|first)\\b`, "i");
  return (out: string) => {
    const tag = afterTag(out);
    const pass = ok.test(tag) && !wrong.test(tag);
    return { outcome: pass ? "pass" : "fail", score: pass ? 1 : 0 };
  };
}

/** String answer: normalised exact match on the tag, else normalised-contains fallback. */
function strAns(expected: string): Verifier {
  const e = norm(expected);
  return (out: string) => {
    const tag = norm(afterTag(out));
    const ok = tag === e || (` ${norm(out)} `.includes(` ${e} `) && e.length > 1);
    return { outcome: ok ? "pass" : "fail", score: ok ? 1 : 0 };
  };
}

const ANS = "\n\nThink briefly, then put your final answer on the last line as `ANSWER: <value>`.";
function p(id: string, taskType: string, prompt: string, verifier: Verifier, verifierName: string): Probe {
  return { id, taskType, prompt: prompt + ANS, maxTokens: 700, temperature: 0, verifier, verifierName };
}

export const HARD_PROBES: Probe[] = [
  // ── multi-step arithmetic / word problems ──
  p("h-tank", "reason-math", "A tank starts empty. It is filled at 8 L/min for 12 min, then drained at 5 L/min for 6 min. How many liters are in the tank now?", numAns(66), "=66"), // 96-30
  p("h-discount", "reason-math", "A shirt costs 80. It is discounted 25%, then 10% sales tax is added to the discounted price. What is the final price?", numAns(66), "=66"), // 60*1.1
  p("h-painters", "reason-math", "If 3 painters paint 3 fences in 3 hours, how many hours do 9 painters need to paint 9 fences (same rate)?", numAns(3), "=3"),
  p("h-xy", "reason-math", "Given x + y = 20 and x - y = 6, what is x * y?", numAns(91), "=91"), // 13*7
  p("h-depreciate", "reason-math", "A car worth 25000 loses 20% of its value each year. What is it worth after 2 years?", numAns(16000), "=16000"), // 25000*.8*.8
  p("h-div7", "reason-math", "What is the sum of all integers from 1 to 100 that are divisible by 7?", numAns(735), "=735"), // 7*105
  p("h-recipe", "reason-math", "A recipe for 4 servings uses 300 g of flour. How many grams of flour are needed for 7 servings?", numAns(525), "=525"), // 75*7
  p("h-percent", "reason-math", "12% of a number is 54. What is 30% of the same number?", numAns(135), "=135"), // n=450
  p("h-batball", "reason-math", "A bat and a ball cost 1.10 in total. The bat costs 1.00 more than the ball. How much does the ball cost, in dollars?", numAns(0.05, 0.001), "=0.05"),

  // ── date / calendar reasoning ──
  p("h-weekday100", "reason-date", "If today is Wednesday, what day of the week is it 100 days from now?", strAns("Friday"), "Friday"), // 100%7=2
  p("h-daterange", "reason-date", "How many days are there from 2024-02-25 to 2024-03-05, counting both endpoints? (2024 is a leap year.)", numAns(10), "=10"),
  p("h-dateadd", "reason-date", "What is the date 10 days after 2025-12-27? Answer as YYYY-MM-DD.", strAns("2026-01-06"), "2026-01-06"),
  p("h-mar1", "reason-date", "January 1, 2025 is a Wednesday. 2025 is not a leap year. What day of the week is March 1, 2025?", strAns("Saturday"), "Saturday"), // 59%7=3
  p("h-meeting", "reason-date", "A meeting starts at 14:45 and lasts 95 minutes. What time does it end? Answer as HH:MM in 24-hour format.", strAns("16:20"), "16:20"),

  // ── unit / base conversion ──
  p("h-hours-sec", "reason-math", "How many seconds are in 2.5 hours?", numAns(9000), "=9000"),
  p("h-bin", "reason-math", "What is the binary number 101101 in decimal?", numAns(45), "=45"), // 32+8+4+1
  p("h-hex", "reason-math", "What is the decimal number 200 in hexadecimal? Give only the hex digits, uppercase.", strAns("C8"), "C8"),
  p("h-kib", "reason-math", "How many bytes are in 3 kibibytes (KiB)?", numAns(3072), "=3072"), // 3*1024

  // ── logic / deduction ──
  p("h-tallest", "reason-logic", "Alice is taller than Bob. Carol is shorter than Bob. Who is the shortest of the three?", strAns("Carol"), "Carol"),
  p("h-syllog", "reason-logic", "All bloops are razzles. All razzles are lazzles. Are all bloops lazzles? Answer yes or no.", strAns("yes"), "yes"),
  p("h-overtake", "reason-logic", "In a race, you overtake the person in 2nd place. What place are you in now?", ordinalAns(2, ["second"]), "2nd"),
  p("h-some", "reason-logic", "Some cats are dogs, and all dogs are blue. Must some cats be blue? Answer yes or no.", strAns("yes"), "yes"),

  // ── string / counting ──
  p("h-counta", "reason-logic", "How many times does the lowercase letter 'a' appear in the word 'abracadabra'?", numAns(5), "=5"),
  p("h-reverse", "data-transform", "Reverse the letters of the word 'stressed'. Give only the resulting word.", strAns("desserts"), "desserts"),
  p("h-7thword", "data-transform", "What is the 7th word in this sentence: 'The quick brown fox jumps over the lazy dog'?", strAns("the"), "the"),
  p("h-vowels", "reason-logic", "How many vowels (a, e, i, o, u) are in the word 'encyclopedia'? Count every occurrence.", numAns(5), "=5"), // e,o,e,i,a

  // ── combinatorics ──
  p("h-moon", "reason-math", "How many distinct arrangements are there of the letters in the word 'MOON'?", numAns(12), "=12"), // 4!/2!
  p("h-committee", "reason-math", "How many different committees of 2 people can be chosen from 5 people?", numAns(10), "=10"), // C(5,2)
  p("h-notdiv3", "reason-math", "How many integers from 1 to 50 inclusive are NOT divisible by 3?", numAns(34), "=34"), // 50-16
];
