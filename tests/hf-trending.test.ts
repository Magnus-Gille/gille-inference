/**
 * hf-trending.test.ts — unit tests for the HuggingFace trending client.
 * All network calls are stubbed — no real HTTP.
 */
import { describe, it, expect } from "vitest";
import {
  parseQuant,
  pickQuant,
  resolveUrl,
  fetchTrending,
  listGgufFiles,
} from "../src/homeserver/hf-trending.js";
import type { GgufFile } from "../src/homeserver/scout-types.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeFile(rfilename: string, sizeBytes: number | null, quant: string): GgufFile {
  return { rfilename, sizeBytes, quant };
}

// ── parseQuant ────────────────────────────────────────────────────────────────

describe("parseQuant", () => {
  it("extracts Q4_K_M from a typical filename", () => {
    expect(parseQuant("Qwen3-Coder-Next-Q4_K_M.gguf")).toBe("Q4_K_M");
  });

  it("extracts IQ4_XS with dot separator", () => {
    expect(parseQuant("model.IQ4_XS.gguf")).toBe("IQ4_XS");
  });

  it("extracts Q8_0", () => {
    expect(parseQuant("mistral-7b-Q8_0.gguf")).toBe("Q8_0");
  });

  it("extracts Q3_K_S", () => {
    expect(parseQuant("llama-Q3_K_S.gguf")).toBe("Q3_K_S");
  });

  it("extracts Q5_K_M", () => {
    expect(parseQuant("model-Q5_K_M.gguf")).toBe("Q5_K_M");
  });

  it("extracts Q6_K", () => {
    expect(parseQuant("model-Q6_K.gguf")).toBe("Q6_K");
  });

  it("extracts IQ2_XXS", () => {
    expect(parseQuant("tiny-IQ2_XXS.gguf")).toBe("IQ2_XXS");
  });

  it("extracts IQ3_XXS", () => {
    expect(parseQuant("model-IQ3_XXS.gguf")).toBe("IQ3_XXS");
  });

  it("extracts IQ4_NL", () => {
    expect(parseQuant("model-IQ4_NL.gguf")).toBe("IQ4_NL");
  });

  it("extracts F16", () => {
    expect(parseQuant("model-F16.gguf")).toBe("F16");
  });

  it("extracts BF16", () => {
    expect(parseQuant("model-BF16.gguf")).toBe("BF16");
  });

  it("is case-insensitive (lowercase quant in filename)", () => {
    expect(parseQuant("model-q4_k_m.gguf")).toBe("Q4_K_M");
  });

  it("returns empty string when no quant tag found", () => {
    expect(parseQuant("llama-base-model.gguf")).toBe("");
  });

  it("returns empty string for unrecognized tag", () => {
    expect(parseQuant("model-WEIRD99.gguf")).toBe("");
  });

  it("extracts quant from sharded filename (last quant segment wins)", () => {
    expect(parseQuant("model-Q4_K_M-00001-of-00003.gguf")).toBe("Q4_K_M");
  });

  it("does not confuse Q3_K for Q3_K_M (longer tag wins when present)", () => {
    // Q3_K_M is longer and should match over Q3_K
    expect(parseQuant("model-Q3_K_M.gguf")).toBe("Q3_K_M");
  });

  it("returns Q4_K_M (last match) when BF16 appears earlier in name as model-family label", () => {
    // e.g. a BF16 base quantized to Q4_K_M — real naming pattern
    expect(parseQuant("Qwen2.5-BF16-Instruct-Q4_K_M.gguf")).toBe("Q4_K_M");
  });
});

// ── pickQuant ─────────────────────────────────────────────────────────────────

describe("pickQuant", () => {
  const GB = 1024 ** 3;

  it("returns null when no files provided", () => {
    expect(pickQuant([], 100)).toBeNull();
  });

  it("returns null when all files exceed budget", () => {
    const files: GgufFile[] = [
      makeFile("model-Q4_K_M.gguf", 80 * GB, "Q4_K_M"),
    ];
    expect(pickQuant(files, 10)).toBeNull();
  });

  it("returns null when files have unknown size", () => {
    const files: GgufFile[] = [
      makeFile("model-Q4_K_M.gguf", null, "Q4_K_M"),
    ];
    expect(pickQuant(files, 100)).toBeNull();
  });

  it("returns null when files have unrecognized quant", () => {
    const files: GgufFile[] = [
      makeFile("model-WEIRD.gguf", 5 * GB, ""),
    ];
    expect(pickQuant(files, 100)).toBeNull();
  });

  it("picks Q4_K_M when it fits", () => {
    const files: GgufFile[] = [
      makeFile("model-Q4_K_M.gguf", 5 * GB, "Q4_K_M"),
      makeFile("model-Q8_0.gguf", 10 * GB, "Q8_0"),
    ];
    const pick = pickQuant(files, 20);
    expect(pick).not.toBeNull();
    expect(pick!.file.rfilename).toBe("model-Q4_K_M.gguf");
    expect(pick!.sizeGB).toBe(5);
  });

  it("falls back to a smaller quant when preferred quant is too big", () => {
    // Q5_K_M and Q4_K_M too big, Q4_K_S fits
    const files: GgufFile[] = [
      makeFile("model-Q5_K_M.gguf", 20 * GB, "Q5_K_M"),
      makeFile("model-Q4_K_M.gguf", 15 * GB, "Q4_K_M"),
      makeFile("model-Q4_K_S.gguf", 8 * GB, "Q4_K_S"),
    ];
    const pick = pickQuant(files, 10);
    expect(pick).not.toBeNull();
    expect(pick!.file.rfilename).toBe("model-Q4_K_S.gguf");
  });

  it("respects preference order: Q5_K_M > Q4_K_M", () => {
    const files: GgufFile[] = [
      makeFile("model-Q4_K_M.gguf", 5 * GB, "Q4_K_M"),
      makeFile("model-Q5_K_M.gguf", 7 * GB, "Q5_K_M"),
    ];
    const pick = pickQuant(files, 20);
    expect(pick).not.toBeNull();
    expect(pick!.file.rfilename).toBe("model-Q5_K_M.gguf");
  });

  it("respects preference order: Q4_K_M > Q6_K (Q6_K is larger but ranked lower)", () => {
    const files: GgufFile[] = [
      makeFile("model-Q6_K.gguf", 6 * GB, "Q6_K"),
      makeFile("model-Q4_K_M.gguf", 5 * GB, "Q4_K_M"),
    ];
    const pick = pickQuant(files, 20);
    expect(pick).not.toBeNull();
    // Q4_K_M is ranked higher in preference even though Q6_K is larger
    expect(pick!.file.rfilename).toBe("model-Q4_K_M.gguf");
  });

  it("prefers Q8_0 over nothing but ranks it last", () => {
    const files: GgufFile[] = [
      makeFile("model-Q8_0.gguf", 5 * GB, "Q8_0"),
    ];
    const pick = pickQuant(files, 10);
    expect(pick).not.toBeNull();
    expect(pick!.file.quant).toBe("Q8_0");
  });

  it("sums sharded parts and returns the first part", () => {
    const files: GgufFile[] = [
      makeFile("model-Q4_K_M-00001-of-00002.gguf", 5 * GB, "Q4_K_M"),
      makeFile("model-Q4_K_M-00002-of-00002.gguf", 5 * GB, "Q4_K_M"),
    ];
    const pick = pickQuant(files, 11); // total 10 GB fits within 11 GB budget
    expect(pick).not.toBeNull();
    expect(pick!.file.rfilename).toBe("model-Q4_K_M-00001-of-00002.gguf");
    expect(pick!.sizeGB).toBe(10);
  });

  it("does not fit sharded quant when total exceeds budget", () => {
    const files: GgufFile[] = [
      makeFile("model-Q4_K_M-00001-of-00002.gguf", 6 * GB, "Q4_K_M"),
      makeFile("model-Q4_K_M-00002-of-00002.gguf", 6 * GB, "Q4_K_M"),
    ];
    // total = 12 GB, budget = 10 GB
    expect(pickQuant(files, 10)).toBeNull();
  });

  it("skips sharded groups with incomplete parts (missing a shard)", () => {
    // Only part 1 of 3 present — cannot size
    const files: GgufFile[] = [
      makeFile("model-Q4_K_M-00001-of-00003.gguf", 5 * GB, "Q4_K_M"),
      makeFile("model-Q4_K_M-00002-of-00003.gguf", 5 * GB, "Q4_K_M"),
      // part 3 missing
    ];
    expect(pickQuant(files, 100)).toBeNull();
  });

  it("ignores files with null sizeBytes when computing shard totals", () => {
    const files: GgufFile[] = [
      makeFile("model-Q4_K_M-00001-of-00002.gguf", 5 * GB, "Q4_K_M"),
      makeFile("model-Q4_K_M-00002-of-00002.gguf", null, "Q4_K_M"), // unknown size
    ];
    // Cannot sum all parts → skip the group
    expect(pickQuant(files, 100)).toBeNull();
  });

  it("sizeGB is rounded to 2 decimal places", () => {
    // 5.5 GB exactly
    const files: GgufFile[] = [
      makeFile("model-Q4_K_M.gguf", 5.5 * GB, "Q4_K_M"),
    ];
    const pick = pickQuant(files, 10);
    expect(pick).not.toBeNull();
    expect(pick!.sizeGB).toBe(5.5);
  });
});

// ── resolveUrl ────────────────────────────────────────────────────────────────

describe("resolveUrl", () => {
  it("builds the correct HF resolve URL", () => {
    expect(resolveUrl("Qwen/Qwen3-Coder-GGUF", "Model-Q4_K_M.gguf")).toBe(
      "https://huggingface.co/Qwen/Qwen3-Coder-GGUF/resolve/main/Model-Q4_K_M.gguf"
    );
  });

  it("builds URL for sharded file", () => {
    expect(resolveUrl("org/repo", "model-Q4_K_M-00001-of-00002.gguf")).toBe(
      "https://huggingface.co/org/repo/resolve/main/model-Q4_K_M-00001-of-00002.gguf"
    );
  });
});

// ── fetchTrending ─────────────────────────────────────────────────────────────

describe("fetchTrending", () => {
  const FAKE_MODELS = [
    { id: "org/model-a", downloads: 1000, likes: 50, trendingScore: 9.5 },
    { id: "org/model-b", downloads: 500, likes: 20, trendingScore: 7.1 },
  ];

  it("maps API results to TrendingModel[]", async () => {
    const stub = async () => makeResponse(FAKE_MODELS);
    const results = await fetchTrending({ fetchImpl: stub as unknown as typeof fetch });
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ id: "org/model-a", downloads: 1000, likes: 50, trendingScore: 9.5 });
    expect(results[1]).toEqual({ id: "org/model-b", downloads: 500, likes: 20, trendingScore: 7.1 });
  });

  it("uses sort=trendingScore in the request URL", async () => {
    let capturedUrl = "";
    const stub = async (url: string) => {
      capturedUrl = url;
      return makeResponse([]);
    };
    await fetchTrending({ fetchImpl: stub as unknown as typeof fetch });
    expect(capturedUrl).toContain("sort=trendingScore");
  });

  it("sets a browser User-Agent header", async () => {
    let capturedUA = "";
    const stub = async (_url: string, init?: RequestInit) => {
      capturedUA = (init?.headers as Record<string, string>)?.["User-Agent"] ?? "";
      return makeResponse([]);
    };
    await fetchTrending({ fetchImpl: stub as unknown as typeof fetch });
    expect(capturedUA).toContain("Mozilla");
  });

  it("includes limit in the URL", async () => {
    let capturedUrl = "";
    const stub = async (url: string) => {
      capturedUrl = url;
      return makeResponse([]);
    };
    await fetchTrending({ limit: 10, fetchImpl: stub as unknown as typeof fetch });
    expect(capturedUrl).toContain("limit=10");
  });

  it("includes gguf in the filter when gguf=true (default)", async () => {
    let capturedUrl = "";
    const stub = async (url: string) => {
      capturedUrl = url;
      return makeResponse([]);
    };
    await fetchTrending({ fetchImpl: stub as unknown as typeof fetch });
    expect(capturedUrl).toContain("gguf");
  });

  it("throws on non-200 response", async () => {
    const stub = async () => makeResponse({ error: "blocked" }, 403);
    await expect(
      fetchTrending({ fetchImpl: stub as unknown as typeof fetch })
    ).rejects.toThrow("403");
  });

  it("defaults missing fields to 0", async () => {
    const stub = async () =>
      makeResponse([{ id: "org/minimal" }]); // no downloads/likes/trendingScore
    const results = await fetchTrending({ fetchImpl: stub as unknown as typeof fetch });
    expect(results[0]).toEqual({ id: "org/minimal", downloads: 0, likes: 0, trendingScore: 0 });
  });
});

// ── listGgufFiles ─────────────────────────────────────────────────────────────

describe("listGgufFiles", () => {
  const FAKE_MODEL_INFO = {
    id: "org/model",
    siblings: [
      { rfilename: "README.md" },
      { rfilename: "model-Q4_K_M.gguf", size: 5 * 1024 ** 3 },
      { rfilename: "model-Q8_0.gguf" }, // no size → will HEAD
      { rfilename: "config.json" },
    ],
  };

  it("returns only .gguf files", async () => {
    const stub = async () => makeResponse(FAKE_MODEL_INFO);
    const files = await listGgufFiles("org/model", { fetchImpl: stub as unknown as typeof fetch, headSize: false });
    expect(files.map((f) => f.rfilename)).toEqual(["model-Q4_K_M.gguf", "model-Q8_0.gguf"]);
  });

  it("uses size from siblings when present", async () => {
    const stub = async () => makeResponse(FAKE_MODEL_INFO);
    const files = await listGgufFiles("org/model", { fetchImpl: stub as unknown as typeof fetch, headSize: false });
    const q4file = files.find((f) => f.rfilename === "model-Q4_K_M.gguf")!;
    expect(q4file.sizeBytes).toBe(5 * 1024 ** 3);
  });

  it("parses quant for each gguf file", async () => {
    const stub = async () => makeResponse(FAKE_MODEL_INFO);
    const files = await listGgufFiles("org/model", { fetchImpl: stub as unknown as typeof fetch, headSize: false });
    expect(files[0].quant).toBe("Q4_K_M");
    expect(files[1].quant).toBe("Q8_0");
  });

  it("sets sizeBytes=null when size absent and headSize=false", async () => {
    const stub = async () => makeResponse(FAKE_MODEL_INFO);
    const files = await listGgufFiles("org/model", { fetchImpl: stub as unknown as typeof fetch, headSize: false });
    const q8file = files.find((f) => f.rfilename === "model-Q8_0.gguf")!;
    expect(q8file.sizeBytes).toBeNull();
  });

  it("uses content-length from HEAD when headSize=true and size missing", async () => {
    const HEAD_SIZE = 10 * 1024 ** 3;
    const stub = async (url: string, init?: RequestInit) => {
      if ((init as RequestInit & { method?: string })?.method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: { "content-length": String(HEAD_SIZE) },
        });
      }
      return makeResponse(FAKE_MODEL_INFO);
    };
    const files = await listGgufFiles("org/model", { fetchImpl: stub as unknown as typeof fetch, headSize: true });
    const q8file = files.find((f) => f.rfilename === "model-Q8_0.gguf")!;
    expect(q8file.sizeBytes).toBe(HEAD_SIZE);
  });

  it("sets sizeBytes=null when HEAD fails (tolerates failure)", async () => {
    const stub = async (_url: string, init?: RequestInit) => {
      if ((init as RequestInit & { method?: string })?.method === "HEAD") {
        throw new Error("network error");
      }
      return makeResponse(FAKE_MODEL_INFO);
    };
    const files = await listGgufFiles("org/model", { fetchImpl: stub as unknown as typeof fetch, headSize: true });
    const q8file = files.find((f) => f.rfilename === "model-Q8_0.gguf")!;
    expect(q8file.sizeBytes).toBeNull();
  });

  it("sets browser User-Agent on the model-info request", async () => {
    let capturedUA = "";
    const stub = async (_url: string, init?: RequestInit) => {
      capturedUA = (init?.headers as Record<string, string>)?.["User-Agent"] ?? "";
      return makeResponse(FAKE_MODEL_INFO);
    };
    await listGgufFiles("org/model", { fetchImpl: stub as unknown as typeof fetch, headSize: false });
    expect(capturedUA).toContain("Mozilla");
  });

  it("throws on non-200 model-info response", async () => {
    const stub = async () => makeResponse({ error: "not found" }, 404);
    await expect(
      listGgufFiles("org/model", { fetchImpl: stub as unknown as typeof fetch })
    ).rejects.toThrow("404");
  });

  it("prefers x-linked-size header over content-length for HF LFS", async () => {
    const LFS_SIZE = 7 * 1024 ** 3;
    const stub = async (_url: string, init?: RequestInit) => {
      if ((init as RequestInit & { method?: string })?.method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: {
            "x-linked-size": String(LFS_SIZE),
            "content-length": "123", // smaller redirect/overhead size
          },
        });
      }
      return makeResponse(FAKE_MODEL_INFO);
    };
    const files = await listGgufFiles("org/model", { fetchImpl: stub as unknown as typeof fetch, headSize: true });
    const q8file = files.find((f) => f.rfilename === "model-Q8_0.gguf")!;
    expect(q8file.sizeBytes).toBe(LFS_SIZE);
  });
});
