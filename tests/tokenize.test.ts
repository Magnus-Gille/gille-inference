import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AdmissionController } from "../src/homeserver/admission.js";
import { loadConfig, type HomeserverConfig } from "../src/homeserver/config.js";
import type { McpPrincipal } from "../src/homeserver/mcp.js";
import { TOKENIZE_MAX_TEXT_BYTES, runTokenize } from "../src/homeserver/tokenize.js";
import { admitHostMemory } from "../src/homeserver/host-memory-admission.js";
import { checkQuota, recordUsage } from "../src/homeserver/quota.js";

vi.mock("../src/homeserver/quota.js", () => ({
  checkQuota: vi.fn(),
  recordUsage: vi.fn(),
}));

vi.mock("../src/homeserver/host-memory-admission.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/homeserver/host-memory-admission.js")>()),
  admitHostMemory: vi.fn(),
}));

const mockedCheckQuota = vi.mocked(checkQuota);
const mockedRecordUsage = vi.mocked(recordUsage);
const mockedAdmitHostMemory = vi.mocked(admitHostMemory);

const BASE_URL = "http://127.0.0.1:4321/v1";
const MODEL = "org/team/model:v1";
const principal: McpPrincipal = {
  alias: "tokenize-test",
  tier: "guest",
  scope: "inference",
  modelAllowList: [],
  limits: { rpm: 60, tpm: 60_000, dailyTokenBudget: 0 },
  maxParallel: 1,
  keyHash: null,
  creditLimit: 0,
};

function allowedQuota() {
  return {
    ok: true as const,
    snapshot: { rpmUsed: 1, rpmLimit: 60, tpmUsed: 0, tpmLimit: 60_000, dailyUsed: 0, dailyLimit: 0, resetSeconds: 60 },
    reservation: { alias: principal.alias, eventId: "tokenize-event", reservedDaily: 0, day: "2026-10-11" },
  };
}

function cfg(overrides: Partial<HomeserverConfig> = {}): HomeserverConfig {
  return {
    ...loadConfig(),
    backend: "llamaswap",
    lmStudioBaseUrl: BASE_URL,
    hostMemoryAdmission: {
      ...loadConfig().hostMemoryAdmission,
      mode: "off",
    },
    ...overrides,
  };
}

function makeInflight() {
  let count = 0;
  return {
    inc: () => { count += 1; },
    dec: () => { count -= 1; },
    current: () => count,
    count: () => count,
  };
}

function makeController(options: { maintenanceMode?: boolean; maxInflight?: number } = {}) {
  return new AdmissionController({
    maxInflight: options.maxInflight ?? 1,
    ownerQueueMaxMs: 50,
    retryAfterAtCapSeconds: 3,
    maintenanceMode: options.maintenanceMode,
  });
}

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function call(
  args: Record<string, unknown> = { model: MODEL, text: "hello" },
  options: {
    config?: HomeserverConfig;
    controller?: AdmissionController;
    hostMemory?: Parameters<typeof runTokenize>[1]["hostMemoryAdmission"];
    inflight?: ReturnType<typeof makeInflight>;
  } = {},
) {
  const inflight = options.inflight ?? makeInflight();
  const controller = options.controller ?? makeController();
  const result = await runTokenize(args, {
    cfg: options.config ?? cfg(),
    principal,
    controller,
    hostMemoryAdmission: options.hostMemory,
    inflight,
  });
  return { result, controller, inflight };
}

const validNative = { tokens: [{ id: 7, piece: "hello" }, { id: 8, piece: [32, 119] }] };
const savedLlamaswapBase = process.env["LLAMASWAP_BASE_URL"];

beforeAll(() => {
  delete process.env["LLAMASWAP_BASE_URL"];
});

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  mockedCheckQuota.mockReturnValue(allowedQuota());
  mockedRecordUsage.mockImplementation(() => undefined);
  mockedAdmitHostMemory.mockResolvedValue(null);
  vi.stubGlobal("fetch", vi.fn());
});

afterAll(() => {
  if (savedLlamaswapBase === undefined) delete process.env["LLAMASWAP_BASE_URL"];
  else process.env["LLAMASWAP_BASE_URL"] = savedLlamaswapBase;
  vi.unstubAllGlobals();
});

describe("runTokenize request boundaries", () => {
  it.each([
    ["missing model", { text: "x" }],
    ["missing text", { model: MODEL }],
    ["extra argument", { model: MODEL, text: "x", extra: true }],
    ["over UTF-8 byte limit", { model: MODEL, text: "a".repeat(TOKENIZE_MAX_TEXT_BYTES + 1) }],
    ["unpaired surrogate", { model: MODEL, text: "bad\ud800text" }],
  ])("rejects %s before quota or fetch", async (_label, args) => {
    const result = await call(args);
    expect(result.result).toMatchObject({ isError: true, meta: { m5_code: "invalid_request" } });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(mockedCheckQuota).not.toHaveBeenCalled();
  });

  it("rejects invalid model ids before quota or fetch", async () => {
    const result = await call({ model: "../escape", text: "x" });
    expect(result.result).toMatchObject({ isError: true, meta: { m5_code: "invalid_request" } });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(mockedCheckQuota).not.toHaveBeenCalled();
  });

  it.each([
    ["lmstudio backend", cfg({ backend: "lmstudio" }), MODEL],
    ["System One model", cfg({ systemOneModels: ["decision-model"] }), "decision-model"],
    ["embedding model", cfg(), "embeddinggemma-2"],
  ])("rejects %s before quota or fetch", async (_label, config, model) => {
    const result = await call({ model, text: "x" }, { config });
    expect(result.result).toMatchObject({ isError: true, meta: { m5_code: "tokenizer_unsupported" } });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(mockedCheckQuota).not.toHaveBeenCalled();
  });

  it("enforces the model grant before quota or fetch", async () => {
    const config = cfg();
    // Use a fresh principal-shaped context with a narrower grant so the real branch is exercised.
    const restricted = await runTokenize({ model: MODEL, text: "x" }, {
      cfg: config,
      principal: { ...principal, modelAllowList: ["other-model"] },
      controller: makeController(),
      inflight: makeInflight(),
    });
    expect(restricted).toMatchObject({ isError: true, meta: { m5_code: "model_not_allowed" } });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it.each([
    ["quota", () => {
      mockedCheckQuota.mockReturnValue({ ok: false, reason: "rpm", retryAfterSeconds: 9,
        snapshot: { rpmUsed: 61, rpmLimit: 60, tpmUsed: 0, tpmLimit: 60_000, dailyUsed: 0, dailyLimit: 0, resetSeconds: 9 } });
      return { controller: makeController() };
    }],
    ["maintenance", () => ({ controller: makeController({ maintenanceMode: true }) })],
  ])("rejects %s before fetch", async (_label, setup) => {
    const { result } = await call(undefined, setup());
    expect(result).toMatchObject({ isError: true, meta: { m5_code: expect.stringMatching(/rate_limited|server_busy/) } });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(result.trace?.traceOutcome).toBe("error");
  });

  it("rejects host-memory refusal before fetch and releases admission", async () => {
    mockedAdmitHostMemory.mockResolvedValue({ code: "insufficient_memory", message: "refused", retryAfterSeconds: 4, reason: "insufficient_memory" });
    const inflight = makeInflight();
    const { result, controller } = await call(undefined, {
      inflight,
      config: cfg({ hostMemoryAdmission: {
        mode: "enforce", modelBudgetBytes: new Map([[MODEL, 1]]), modelReclaimBytes: new Map(), reserveBytes: 1, retryAfterSeconds: 4,
      } }),
    });
    expect(result).toMatchObject({ isError: true, meta: { m5_code: "server_busy" } });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(controller.snapshot().inflight).toBe(0);
    expect(inflight.count()).toBe(0);
    expect(mockedRecordUsage).toHaveBeenCalledWith(principal.alias, 0, expect.any(Number), expect.anything());
  });
});

describe("runTokenize native backend contract", () => {
  it("sends the exact native payload and preserves response metadata", async () => {
    vi.mocked(fetch).mockResolvedValue(response(validNative));
    const { result } = await call();
    expect(result).toMatchObject({ isError: false, structuredContent: {
      model: MODEL, count: 2, tokens: [7, 8], pieces: ["hello", [32, 119]], add_special: false, parse_special: false,
    } });
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      `${BASE_URL.replace(/\/v1$/, "")}/upstream/${encodeURIComponent(MODEL)}/tokenize`,
      expect.objectContaining({ method: "POST", redirect: "error", body: JSON.stringify({ content: "hello", add_special: false, parse_special: false, with_pieces: true }) }),
    );
    expect(mockedRecordUsage).toHaveBeenCalledWith(principal.alias, 0, expect.any(Number), expect.anything());
  });

  it("accepts empty text and forwards it unchanged", async () => {
    vi.mocked(fetch).mockResolvedValue(response({ tokens: [] }));
    const { result } = await call({ model: MODEL, text: "" });
    expect(result).toMatchObject({ isError: false, structuredContent: {
      model: MODEL, count: 0, tokens: [], pieces: [], add_special: false, parse_special: false,
    } });
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      body: JSON.stringify({ content: "", add_special: false, parse_special: false, with_pieces: true }),
    }));
  });

  it("classifies a stalled body as timeout and releases the slot", async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockImplementation(async (_input, init) => {
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
        },
      });
      return new Response(body, { status: 200 });
    });
    const pending = call(undefined, { config: cfg({ callTimeoutMs: 25 }) });
    await vi.advanceTimersByTimeAsync(25);
    const { result, controller, inflight } = await pending;
    expect(result).toMatchObject({ isError: true, meta: { m5_code: "upstream_timeout" } });
    expect(controller.snapshot().inflight).toBe(0);
    expect(inflight.count()).toBe(0);
  });

  it("allows a native reply beyond 60 seconds within the configured timeout", async () => {
    vi.useFakeTimers();
    const delayMs = 90_000;
    vi.mocked(fetch).mockImplementation(async (_input, init) => new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(response(validNative)), delayMs);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("aborted", "AbortError"));
      }, { once: true });
    }));
    const inflight = makeInflight();
    const controller = makeController();
    let settled = false;
    const pending = runTokenize({ model: MODEL, text: "hello" }, {
      cfg: cfg({ callTimeoutMs: 120_000 }),
      principal,
      controller,
      inflight,
    }).then(result => {
      settled = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(60_001);
    expect(settled).toBe(false);
    expect(controller.snapshot().inflight).toBe(1);
    expect(inflight.count()).toBe(1);

    await vi.advanceTimersByTimeAsync(delayMs - 60_001);
    const result = await pending;
    expect(result).toMatchObject({ isError: false, structuredContent: {
      model: MODEL, count: 2, tokens: [7, 8], pieces: ["hello", [32, 119]], add_special: false, parse_special: false,
    } });
    expect(controller.snapshot().inflight).toBe(0);
    expect(inflight.count()).toBe(0);
    expect(mockedRecordUsage).toHaveBeenCalledWith(principal.alias, 0, expect.any(Number), expect.anything());
  });

  it("waits until the configured timeout beyond 60 seconds, then releases the slot", async () => {
    vi.useFakeTimers();
    const timeoutMs = 120_000;
    vi.mocked(fetch).mockImplementation(async (_input, init) => {
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
        },
      });
      return new Response(body, { status: 200 });
    });
    const inflight = makeInflight();
    const controller = makeController();
    let settled = false;
    const pending = runTokenize({ model: MODEL, text: "hello" }, {
      cfg: cfg({ callTimeoutMs: timeoutMs }),
      principal,
      controller,
      inflight,
    }).then(result => {
      settled = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(60_001);
    expect(settled).toBe(false);
    expect(controller.snapshot().inflight).toBe(1);
    expect(inflight.count()).toBe(1);

    await vi.advanceTimersByTimeAsync(timeoutMs - 60_001);
    const result = await pending;
    expect(result).toMatchObject({ isError: true, meta: { m5_code: "upstream_timeout" } });
    expect(controller.snapshot().inflight).toBe(0);
    expect(inflight.count()).toBe(0);
    expect(mockedRecordUsage).toHaveBeenCalledWith(principal.alias, 0, expect.any(Number), expect.anything());
  });

  it("rejects an oversized response before parsing", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("x".repeat(1_048_577), { status: 200 }));
    const { result } = await call();
    expect(result).toMatchObject({ isError: true, meta: { m5_code: "invalid_tokenizer_response" } });
    expect(result.text).not.toContain("x");
  });

  it("maps rejected redirects to an unavailable backend without echoing details", async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError("redirect disallowed: internal-host"));
    const { result } = await call();
    expect(result).toMatchObject({ isError: true, meta: { m5_code: "upstream_unavailable" } });
    expect(result.text).not.toContain("internal-host");
  });

  it("rejects malformed and IDs-only native responses without estimating", async () => {
    vi.mocked(fetch).mockResolvedValue(response({ tokens: [{ id: 7 }] }));
    const { result } = await call();
    expect(result).toMatchObject({ isError: true, meta: { m5_code: "invalid_tokenizer_response" } });
    expect(result.text).toContain("No token count was estimated");
  });

  it.each([404, 405, 501])("reports native endpoint status %s as unsupported", async (status) => {
    vi.mocked(fetch).mockResolvedValue(response({ error: "not available" }, status));
    const { result } = await call();
    expect(result).toMatchObject({ isError: true, meta: { m5_code: "tokenizer_unsupported" } });
    expect(result.text).toContain("No token count was estimated");
  });

  it("sanitizes 5xx responses and leaves no admission or in-flight residue", async () => {
    const marker = "/private/internal/secret-path HOSTPORT 127.0.0.1:9999";
    vi.mocked(fetch).mockResolvedValue(response({ error: marker }, 503));
    const inflight = makeInflight();
    const { result, controller } = await call(undefined, { inflight });
    expect(result).toMatchObject({ isError: true, meta: { m5_code: "upstream_error" } });
    expect(result.text).not.toContain(marker);
    expect(controller.snapshot().inflight).toBe(0);
    expect(inflight.count()).toBe(0);
    expect(mockedRecordUsage).toHaveBeenCalledWith(principal.alias, 0, expect.any(Number), expect.anything());
  });

  it("turns a refused fetch into upstream_unavailable without body echo", async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError("fetch failed: ECONNREFUSED secret-host"));
    const { result } = await call();
    expect(result).toMatchObject({ isError: true, meta: { m5_code: "upstream_unavailable" } });
    expect(result.text).not.toContain("secret-host");
  });
});
