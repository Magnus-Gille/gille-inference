/**
 * hf-trending.ts — Read-only HuggingFace client for the weekly model scout.
 *
 * No API key required. HF's Cloudflare-protected API REQUIRES a browser
 * User-Agent — the default Node/urllib UA gets a 1010 block.
 *
 * Exports:
 *   parseQuant   — pure, extract GGUF quant tag from a filename
 *   pickQuant    — pure, choose best-fitting quant given a memory budget
 *   resolveUrl   — pure, build the HF resolve URL for a file
 *   fetchTrending — fetch the HF trending-model list (injectable fetchImpl)
 *   listGgufFiles — list GGUF siblings of a model repo (injectable fetchImpl)
 */

import type { GgufFile, TrendingModel, QuantPick } from "./scout-types.js";

// ── constants ─────────────────────────────────────────────────────────────────

const BROWSER_UA = "Mozilla/5.0";

/**
 * All recognized quant tags, UPPERCASE, longer variants listed before their
 * prefixes so the longest-match wins when scanning by position.
 */
const KNOWN_QUANTS: readonly string[] = [
  // IQ tags — XXS before XS, etc.
  "IQ2_XXS", "IQ2_XS", "IQ2_S", "IQ2_M",
  "IQ3_XXS", "IQ3_XS", "IQ3_S", "IQ3_M", "IQ3_XL",
  "IQ4_XS", "IQ4_NL", "IQ4_XL",
  // Q tags — longer (_K_S/_K_M/_K_L) before shorter (_K)
  "Q2_K",
  "Q3_K_L", "Q3_K_M", "Q3_K_S", "Q3_K",
  "Q4_K_M", "Q4_K_S", "Q4_K", "Q4_0", "Q4_1",
  "Q5_K_M", "Q5_K_S", "Q5_K", "Q5_0", "Q5_1",
  "Q6_K",
  "Q8_0",
  // 4-bit float (gpt-oss / OpenAI-class GGUFs) — good quality/size, treated near Q4.
  "MXFP4",
  // Floating-point precisions — large/low-value, ranked last in preference
  "BF16", "F16",
];

/**
 * Preference order for quality vs. size trade-off (best → worst).
 * Q8/F16 rank last: they are large files with diminishing quality returns
 * and we almost never want them when budgets are tight.
 */
const QUANT_PREFERENCE: readonly string[] = [
  "Q5_K_M", "Q4_K_M", "MXFP4", "Q5_K_S", "Q4_K_S", "Q6_K",
  "Q3_K_L", "Q3_K_M", "IQ4_XS", "Q3_K_S", "IQ3_XXS",
  "Q2_K", "IQ2_XXS", "Q8_0", "F16", "BF16",
];

// ── pure helpers ──────────────────────────────────────────────────────────────

/**
 * Extract the GGUF quant tag from a filename.  Scans for all known tags,
 * returns the one at the HIGHEST position in the string (rightmost match).
 * This correctly handles filenames like "Qwen2.5-BF16-Base-Q4_K_M.gguf"
 * where "BF16" is the model-family label and "Q4_K_M" is the actual quant.
 *
 * Boundaries: the tag must be preceded by [-. or start-of-string] and
 * followed by [-.] or end-of-string (after normalising to upper case).
 *
 * Returns "" when no recognized quant tag is found.
 */
export function parseQuant(rfilename: string): string {
  const upper = rfilename.toUpperCase();
  let bestQuant = "";
  let bestPos = -1;

  for (const q of KNOWN_QUANTS) {
    // Boundary: tag must be preceded by [-. or start] and followed by [-.] or end.
    // We test against the already-uppercased string (the regex flag is redundant but harmless).
    const re = new RegExp(`(?:^|[-.])${q}(?=[.-]|$)`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(upper)) !== null) {
      if (m.index > bestPos) {
        bestPos = m.index;
        bestQuant = q;
      }
    }
  }

  return bestQuant;
}

/**
 * Pick the best-fitting GGUF quant for a given memory budget.
 *
 * Algorithm:
 * 1. Filter out files with null sizeBytes or empty/unknown quant.
 * 2. Group sharded files (matching *-NNNNN-of-NNNNN.gguf) by (baseName, quant).
 *    A shard group is only considered when ALL expected parts are present and sized.
 *    Non-sharded files are each their own candidate.
 * 3. Walk QUANT_PREFERENCE; return the first candidate whose total size fits
 *    within memBudgetGB.  The returned QuantPick carries the first-part rfilename
 *    and total sizeGB (rounded to 2 dp).
 *
 * Returns null if no candidate fits.
 */
export function pickQuant(files: GgufFile[], memBudgetGB: number): QuantPick | null {
  interface Candidate {
    quant: string;
    totalBytes: number;
    firstFile: GgufFile;
    parts: string[]; // ordered rfilenames of this group
  }

  const candidates: Candidate[] = [];

  // ── shard detection ─────────────────────────────────────────────────────────
  // Key: "<baseName>::<quant>" → grouped shard info
  interface ShardGroup {
    expectedParts: number;
    // part number → sizeBytes (guaranteed non-null, filtered above)
    parts: Map<number, { sizeBytes: number; file: GgufFile }>;
  }
  const shardMap = new Map<string, ShardGroup>();
  const singles: GgufFile[] = [];

  for (const f of files) {
    if (f.sizeBytes === null || f.quant === "") continue;

    const m = f.rfilename.match(/^(.+?)-(\d{5})-of-(\d{5})\.gguf$/i);
    if (m) {
      const baseName = m[1];
      const partNum = parseInt(m[2], 10);
      const totalParts = parseInt(m[3], 10);
      const groupKey = `${baseName}::${f.quant}`;

      if (!shardMap.has(groupKey)) {
        shardMap.set(groupKey, { expectedParts: totalParts, parts: new Map() });
      }
      const sg = shardMap.get(groupKey)!;
      // Guard against malformed "of-X" mismatch across parts
      if (sg.expectedParts === totalParts) {
        sg.parts.set(partNum, { sizeBytes: f.sizeBytes, file: f });
      }
    } else {
      singles.push(f);
    }
  }

  // ── complete shard groups → candidates ──────────────────────────────────────
  for (const [, sg] of shardMap) {
    if (sg.parts.size !== sg.expectedParts) continue; // incomplete — skip

    const sorted = Array.from(sg.parts.entries()).sort(([a], [b]) => a - b);
    const totalBytes = sorted.reduce((acc, [, p]) => acc + p.sizeBytes, 0);
    const firstFile = sorted[0][1].file;
    const parts = sorted.map(([, p]) => p.file.rfilename);
    candidates.push({ quant: firstFile.quant, totalBytes, firstFile, parts });
  }

  // ── single files → candidates ────────────────────────────────────────────────
  for (const f of singles) {
    candidates.push({ quant: f.quant, totalBytes: f.sizeBytes!, firstFile: f, parts: [f.rfilename] });
  }

  // ── apply preference order ────────────────────────────────────────────────────
  for (const prefQuant of QUANT_PREFERENCE) {
    for (const cand of candidates) {
      if (cand.quant !== prefQuant) continue;
      const sizeGB = Math.round((cand.totalBytes / 1024 ** 3) * 100) / 100;
      if (sizeGB <= memBudgetGB) {
        // Return a GgufFile with sizeBytes = summed total (consistent with sizeGB)
        const file: GgufFile = {
          rfilename: cand.firstFile.rfilename,
          sizeBytes: cand.totalBytes,
          quant: cand.firstFile.quant,
        };
        return { file, sizeGB, parts: cand.parts };
      }
    }
  }

  return null;
}

/**
 * Build the HuggingFace direct-download URL for a GGUF file.
 * Segments of `id` and `rfilename` are URL-encoded individually.
 */
export function resolveUrl(id: string, rfilename: string): string {
  const encodedId = id.split("/").map(encodeURIComponent).join("/");
  return `https://huggingface.co/${encodedId}/resolve/main/${encodeURIComponent(rfilename)}`;
}

// ── network helpers ───────────────────────────────────────────────────────────

/**
 * Fetch the HuggingFace trending-model list.
 *
 * @param opts.task      Filter by pipeline tag (default "text-generation")
 * @param opts.gguf      Whether to filter by the "gguf" tag (default true)
 * @param opts.limit     Number of results to request (default 30)
 * @param opts.fetchImpl Injectable fetch (default global fetch). Accepts the
 *                       standard (url: string, init?: RequestInit) signature.
 */
export async function fetchTrending(opts?: {
  task?: string;
  gguf?: boolean;
  limit?: number;
  fetchImpl?: typeof fetch;
}): Promise<TrendingModel[]> {
  const task = opts?.task ?? "text-generation";
  const gguf = opts?.gguf ?? true;
  const limit = opts?.limit ?? 30;
  const fetchFn = opts?.fetchImpl ?? fetch;

  const filterParts = [gguf ? "gguf" : "", task].filter(Boolean);
  const filter = filterParts.join(",");
  const url =
    `https://huggingface.co/api/models?sort=trendingScore&limit=${limit}&filter=${filter}`;

  const res = await fetchFn(url, {
    headers: { "User-Agent": BROWSER_UA },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(
      `fetchTrending: ${res.status} ${res.statusText} fetching ${url}`
    );
  }

  const json = (await res.json()) as Array<Record<string, unknown>>;
  return json.map((m) => ({
    id: String(m["id"] ?? ""),
    downloads: Number(m["downloads"] ?? 0),
    likes: Number(m["likes"] ?? 0),
    trendingScore: Number(m["trendingScore"] ?? 0),
  }));
}

/**
 * List GGUF files in a HuggingFace model repo.
 *
 * Calls the model-info endpoint (`/api/models/<id>`) and filters `siblings`
 * to `*.gguf` entries.  Size is resolved in this order:
 *   1. `siblings[].size` from the model-info response (when present).
 *   2. HEAD request on the resolve URL: `x-linked-size` first (HF LFS),
 *      then `content-length`.  Failures are tolerated → sizeBytes = null.
 *
 * @param opts.headSize  Whether to HEAD-request for missing sizes (default true)
 * @param opts.fetchImpl Injectable fetch (default global fetch)
 */
export async function listGgufFiles(
  id: string,
  opts?: { fetchImpl?: typeof fetch; headSize?: boolean }
): Promise<GgufFile[]> {
  const fetchFn = opts?.fetchImpl ?? fetch;
  const headSize = opts?.headSize ?? true;

  const encodedId = id.split("/").map(encodeURIComponent).join("/");
  const url = `https://huggingface.co/api/models/${encodedId}`;

  const res = await fetchFn(url, {
    headers: { "User-Agent": BROWSER_UA },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(
      `listGgufFiles: ${res.status} ${res.statusText} for model ${id}`
    );
  }

  const json = (await res.json()) as {
    siblings?: Array<{ rfilename: string; size?: number }>;
  };
  const siblings = json.siblings ?? [];
  const ggufSiblings = siblings.filter((s) => s.rfilename.endsWith(".gguf"));

  const files: GgufFile[] = await Promise.all(
    ggufSiblings.map(async (s): Promise<GgufFile> => {
      const quant = parseQuant(s.rfilename);
      let sizeBytes: number | null =
        s.size !== undefined ? s.size : null;

      if (sizeBytes === null && headSize) {
        try {
          const headUrl = resolveUrl(id, s.rfilename);
          const headRes = await fetchFn(headUrl, {
            method: "HEAD",
            headers: { "User-Agent": BROWSER_UA },
            signal: AbortSignal.timeout(15_000),
          });
          // HF LFS serves the true file size in x-linked-size; content-length
          // on a redirect may be the redirect body length — prefer x-linked-size.
          const cl =
            headRes.headers.get("x-linked-size") ??
            headRes.headers.get("content-length");
          if (cl) sizeBytes = parseInt(cl, 10);
        } catch {
          // HEAD failed (timeout, 403, network error) — tolerated per spec;
          // size remains null. This is not a logic error we should mask — the
          // caller can still use the file entry, just without a size.
        }
      }

      return { rfilename: s.rfilename, sizeBytes, quant };
    })
  );

  return files;
}
