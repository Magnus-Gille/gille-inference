const MAX_BODY_BYTES = 128 * 1024;
const MAX_SAFE_INTEGER = 9_007_199_254_740_991n;

export type LlamaCppActivityMetrics = {
  state: "observed" | "unknown";
  active: number | null;
  queued: number | null;
  reason: "ok" | "missing-metrics" | "invalid-metrics" | "body-too-large";
};

const TARGETS = [
  { name: "llamacpp:requests_processing", key: "active" },
  { name: "llamacpp:requests_deferred", key: "queued" },
] as const;

function unknown(reason: Exclude<LlamaCppActivityMetrics["reason"], "ok">): LlamaCppActivityMetrics {
  return { state: "unknown", active: null, queued: null, reason };
}

function hasMetricBoundary(line: string, name: string): boolean {
  if (!line.startsWith(name)) return false;
  const next = line[name.length];
  return next === undefined || next === "{" || next === " " || next === "\t";
}

function parseSafeNonNegativeInteger(value: string): number | null {
  if (!/^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return null;

  const unsigned = value.startsWith("+") ? value.slice(1) : value;
  const exponentIndex = unsigned.search(/[eE]/);
  const mantissa = exponentIndex === -1 ? unsigned : unsigned.slice(0, exponentIndex);
  const exponentText = exponentIndex === -1 ? "0" : unsigned.slice(exponentIndex + 1);
  const dotIndex = mantissa.indexOf(".");
  const integerPart = dotIndex === -1 ? mantissa : mantissa.slice(0, dotIndex);
  const fractionPart = dotIndex === -1 ? "" : mantissa.slice(dotIndex + 1);
  let digits = `${integerPart}${fractionPart}`.replace(/^0+(?=\d)/, "");

  if (/^0+$/.test(digits)) return 0;

  const exponent = BigInt(exponentText);
  let shift = exponent - BigInt(fractionPart.length);

  if (shift < 0n) {
    const trailingZeros = digits.length - digits.replace(/0+$/, "").length;
    const remove = -shift;
    if (remove > BigInt(trailingZeros)) return null;
    digits = digits.slice(0, digits.length - Number(remove));
    shift = 0n;
  }

  const finalLength = BigInt(digits.length) + shift;
  if (finalLength > 16n) return null;
  digits += "0".repeat(Number(shift));

  const result = BigInt(digits);
  return result <= MAX_SAFE_INTEGER ? Number(result) : null;
}

function isTargetTypeLine(line: string, name: string): boolean {
  const prefix = /^\s*#\s*TYPE\b\s*/.exec(line);
  return prefix !== null && hasMetricBoundary(line.slice(prefix[0].length), name);
}

function isTargetSampleLine(line: string, name: string): boolean {
  const trimmed = line.trim();
  return hasMetricBoundary(trimmed, name);
}

export function parseLlamaCppActivityMetrics(text: string): LlamaCppActivityMetrics {
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) return unknown("body-too-large");

  const typeCounts = { active: 0, queued: 0 };
  const sampleCounts = { active: 0, queued: 0 };
  const values: { active: number | null; queued: number | null } = { active: null, queued: null };
  let invalid = false;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

    for (const target of TARGETS) {
      if (isTargetTypeLine(line, target.name)) {
        if (line !== `# TYPE ${target.name} gauge`) {
          invalid = true;
        } else {
          typeCounts[target.key] += 1;
          if (typeCounts[target.key] > 1) invalid = true;
        }
        continue;
      }

      if (!isTargetSampleLine(line, target.name)) continue;
      const sample = line.trim();
      const sampleMatch = sample.match(new RegExp(`^${target.name}[ \\t]+([^ \\t]+)[ \\t]*$`));
      if (!sampleMatch) {
        invalid = true;
        continue;
      }

      const parsed = parseSafeNonNegativeInteger(sampleMatch[1]);
      if (parsed === null) {
        invalid = true;
        continue;
      }
      sampleCounts[target.key] += 1;
      values[target.key] = parsed;
      if (sampleCounts[target.key] > 1) invalid = true;
    }
  }

  if (invalid) return unknown("invalid-metrics");
  if (
    typeCounts.active !== 1 ||
    typeCounts.queued !== 1 ||
    sampleCounts.active !== 1 ||
    sampleCounts.queued !== 1
  ) return unknown("missing-metrics");
  return { state: "observed", active: values.active, queued: values.queued, reason: "ok" };
}
