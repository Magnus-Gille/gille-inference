import { describe, expect, it } from "vitest";

import {
  PROMOTION_DEFAULTS,
  applyManualPromotion,
  existingKeys,
  modelsIsLastTopLevel,
  parseManualSpec,
  renderManualEntry,
  type ManualPromotionDeps,
  type ManualServingSpec,
} from "../src/homeserver/manual-promotion.js";

const FULL_SPEC_TEXT = [
  "key: manual-35b",
  "gguf: /m/manual-35b.Q4_K_M.gguf",
  "runtime_bin: /r/9b05354ec/bin/llama-server",
  "ctx: 65536",
  "ngl: 999",
  "ubatch: 512",
  "np: 1",
  "jinja: true",
  "fa: on",
  "cache_ram_mib: 2048",
  "ctk: q8_0",
  "ctv: q8_0",
  "mmproj: /m/mmproj-BF16.gguf",
  "image_min_tokens: 1024",
  "spec_type: draft-mtp",
  "spec_draft_n_max: 2",
  "reasoning_format: auto",
  "reasoning: auto",
  "ttl: 1800",
].join("\n");

const EXPECTED_ENTRY = [
  '  "manual-35b":',
  "    cmd: |",
  "      /r/9b05354ec/bin/llama-server",
  "      --host 127.0.0.1 --port ${PORT}",
  "      -m /m/manual-35b.Q4_K_M.gguf",
  "      -mm /m/mmproj-BF16.gguf",
  "      --image-min-tokens 1024",
  "      -ngl 999 -ub 512 -c 65536 -np 1 --jinja -fa on",
  "      --spec-type draft-mtp --spec-draft-n-max 2",
  "      --reasoning-format auto --reasoning auto",
  "      --cache-ram 2048 -ctk q8_0 -ctv q8_0",
  "    ttl: 1800",
  "",
].join("\n");

const BASE_CONFIG = [
  "health: ok",
  "models:",
  '  "qwen38-27b":',
  "    cmd: |",
  "      /bin/llama-server",
  "    ttl: 1800",
  "",
].join("\n");

describe("manual-promotion spec contract (#217)", () => {
  it("parses a full reviewed spec", () => {
    expect(parseManualSpec(FULL_SPEC_TEXT)).toEqual({
      key: "manual-35b",
      gguf: "/m/manual-35b.Q4_K_M.gguf",
      runtimeBin: "/r/9b05354ec/bin/llama-server",
      ctx: 65536,
      ngl: 999,
      ubatch: 512,
      np: 1,
      jinja: true,
      fa: "on",
      cacheRamMib: 2048,
      ctk: "q8_0",
      ctv: "q8_0",
      mmproj: "/m/mmproj-BF16.gguf",
      imageMinTokens: 1024,
      specType: "draft-mtp",
      specDraftNMax: 2,
      reasoningFormat: "auto",
      reasoning: "auto",
      ttl: 1800,
    });
  });

  it("accepts a minimal text-only spec with optionals absent", () => {
    const spec = parseManualSpec(
      [
        "key: tiny-1b",
        "gguf: /m/tiny.gguf",
        "runtime_bin: /r/bin/llama-server",
        "ctx: 8192",
        "ngl: 0",
        "ubatch: 512",
        "fa: off",
        "cache_ram_mib: 512",
        "ctk: f16",
        "ctv: f16",
        "ttl: 900",
      ].join("\n"),
    );
    expect(spec).toMatchObject({
      np: null,
      jinja: true,
      mmproj: null,
      imageMinTokens: null,
      specType: null,
      specDraftNMax: null,
      reasoningFormat: null,
      reasoning: null,
    });
    expect(renderManualEntry(spec)).toContain("-ngl 0 -ub 512 -c 8192 --jinja -fa off");
    expect(renderManualEntry(spec)).not.toContain("-mm ");
    expect(renderManualEntry(spec)).not.toContain("--spec-type");
  });

  it.each([
    ["unknown field", `${FULL_SPEC_TEXT}\n Englisch: yes`],
    ["duplicate field", `${FULL_SPEC_TEXT}\nttl: 900`],
    ["missing required", "key: x"],
    ["unparseable line", "just some words"],
    ["bad key charset", FULL_SPEC_TEXT.replace("key: manual-35b", "key: ornith;rm")],
    ["relative gguf", FULL_SPEC_TEXT.replace("gguf: /m/", "gguf: m/")],
    ["traversal gguf", FULL_SPEC_TEXT.replace("gguf: /m/", "gguf: /m/../")],
    ["bad fa", FULL_SPEC_TEXT.replace("fa: on", "fa: sometimes")],
    ["spec_type without draft max", FULL_SPEC_TEXT.replace("spec_draft_n_max: 2\n", "")],
    ["reasoning without format", FULL_SPEC_TEXT.replace("reasoning_format: auto\n", "")],
    ["out-of-range ctx", FULL_SPEC_TEXT.replace("ctx: 65536", "ctx: 16")],
    ["bad kv quant", FULL_SPEC_TEXT.replace("ctk: q8_0", "ctk: mxfp4")],
  ])("rejects a spec with %s", (_label, text) => {
    expect(() => parseManualSpec(text)).toThrow(/manual-promotion/);
  });

  it("renders the exact house-format entry block", () => {
    expect(renderManualEntry(parseManualSpec(FULL_SPEC_TEXT))).toBe(EXPECTED_ENTRY);
  });

  it("accepts dots in model keys", () => {
    const spec = parseManualSpec(FULL_SPEC_TEXT.replace("key: manual-35b", "key: " + "dotted.1-5b"));
    expect(spec.key).toBe("dotted.1-5b");
  });

  it("pins corrected box-layout defaults with no stale /srv family paths", () => {
    expect(PROMOTION_DEFAULTS).toEqual({
      configPath: "/etc/gille-inference/llama-swap/config.yaml",
      llamaswapUrl: "http://127.0.0.1:8091",
      maxServed: 12,
      restartCommand: "sudo systemctl restart llama-swap",
    });
    expect(JSON.stringify(PROMOTION_DEFAULTS)).not.toContain("/srv/");
    expect(JSON.stringify(PROMOTION_DEFAULTS)).not.toContain("/etc/llama-swap");
    expect(JSON.stringify(PROMOTION_DEFAULTS)).not.toContain("/opt/llama.cpp");
  });
});

describe("manual-promotion structural guards (#217)", () => {
  it("reads served keys from config text", () => {
    expect(existingKeys(BASE_CONFIG)).toEqual(new Set(["qwen38-27b"]));
  });

  it("accepts appends only when models: is the last top-level key", () => {
    expect(modelsIsLastTopLevel(BASE_CONFIG)).toBe(true);
    expect(modelsIsLastTopLevel(`${BASE_CONFIG}aliases:\n  x: y\n`)).toBe(false);
    expect(modelsIsLastTopLevel("health: ok\n")).toBe(false);
  });
});

describe("manual-promotion transaction (#217)", () => {
  interface Harness {
    deps: ManualPromotionDeps;
    calls: { backups: string[]; applies: string[]; restores: string[]; commands: string[][] };
    live: { text: string };
  }

  function harness(
    configText: string,
    options: {
      files?: Set<string>;
      listed?: string[];
      restartCode?: number;
      restartCodes?: number[];
      corruptReadback?: boolean;
    } = {},
  ): Harness {
    const files = options.files ?? new Set(["/m/manual-35b.Q4_K_M.gguf", "/m/mmproj-BF16.gguf"]);
    const backups = new Map<string, string>();
    const calls = { backups: [] as string[], applies: [] as string[], restores: [] as string[], commands: [] as string[][] };
    const live = { text: configText };
    const deps: ManualPromotionDeps = {
      readConfig: () => live.text,
      fileExists: (path) => files.has(path),
      writeBackup: async (id, content) => {
        calls.backups.push(id);
        backups.set(id, content);
      },
      applyConfig: async (content) => {
        calls.applies.push(content);
        live.text = content;
      },
      readBackConfig: () => (options.corruptReadback ? `${live.text}#corrupt` : live.text),
      restoreBackup: async (id) => {
        calls.restores.push(id);
        live.text = backups.get(id) as string;
      },
      runCommand: async (argv) => {
        calls.commands.push(argv);
        const code = options.restartCodes?.length
          ? (options.restartCodes.shift() as number)
          : (options.restartCode ?? 0);
        return { code, stdout: "", stderr: "" };
      },
      modelsListed: async () => options.listed ?? ["manual-35b"],
      warmupModel: async () => {},
      sleep: async () => {},
      now: () => new Date("2026-09-11T00:00:00.000Z"),
    };
    return { deps, calls, live };
  }

  function spec(): ManualServingSpec {
    return parseManualSpec(FULL_SPEC_TEXT);
  }

  it("promotes exactly one entry with backup, verify, restart, and health check", async () => {
    const { deps, calls, live } = harness(BASE_CONFIG);
    const result = await applyManualPromotion(spec(), deps);
    expect(result).toMatchObject({ key: "manual-35b", restored: false });
    expect(calls.backups).toHaveLength(1);
    expect(calls.applies).toHaveLength(1);
    expect(calls.restores).toHaveLength(0);
    expect(calls.commands).toEqual([["sudo", "systemctl", "restart", "llama-swap"]]);
    expect(live.text).toBe(`${BASE_CONFIG}${EXPECTED_ENTRY}`);
  });

  it("refuses an existing key before any backup", async () => {
    const { deps, calls } = harness(BASE_CONFIG);
    await expect(
      applyManualPromotion({ ...spec(), key: "qwen38-27b" }, deps),
    ).rejects.toThrow(/additive only/);
    expect(calls.backups).toHaveLength(0);
    expect(calls.commands).toHaveLength(0);
  });

  it("refuses beyond the served-count ceiling before any backup", async () => {
    const { deps, calls } = harness(BASE_CONFIG);
    await expect(
      applyManualPromotion(spec(), { ...deps, maxServed: 1 }),
    ).rejects.toThrow(/ceiling/);
    expect(calls.backups).toHaveLength(0);
  });

  it("refuses a structurally unsafe config before any backup", async () => {
    const { deps, calls } = harness(`${BASE_CONFIG}aliases:\n  x: y\n`);
    await expect(applyManualPromotion(spec(), deps)).rejects.toThrow(/top-level key/);
    expect(calls.backups).toHaveLength(0);
  });

  it("refuses a missing GGUF before any backup", async () => {
    const { deps, calls } = harness(BASE_CONFIG, { files: new Set() });
    await expect(applyManualPromotion(spec(), deps)).rejects.toThrow(/not present on disk/);
    expect(calls.backups).toHaveLength(0);
  });

  it("restores byte-identical config and restarts when health never lists the key", async () => {
    const { deps, calls, live } = harness(BASE_CONFIG, { listed: ["qwen38-27b"] });
    await expect(
      applyManualPromotion(spec(), { ...deps, listTimeoutMs: 1 }),
    ).rejects.toThrow(/restored backup and restarted/);
    expect(live.text).toBe(BASE_CONFIG);
    expect(calls.restores).toHaveLength(1);
    expect(calls.commands).toHaveLength(2);
  });

  it("restores and restarts when the restart command exits nonzero", async () => {
    const { deps, calls, live } = harness(BASE_CONFIG, { restartCodes: [1, 0] });
    await expect(applyManualPromotion(spec(), deps)).rejects.toThrow(/restored backup and restarted/);
    expect(live.text).toBe(BASE_CONFIG);
    expect(calls.commands).toHaveLength(2);
  });

  it("escalates when the restart after rollback also fails", async () => {
    const { deps, calls, live } = harness(BASE_CONFIG, { restartCode: 1 });
    await expect(applyManualPromotion(spec(), deps)).rejects.toThrow(
      /restart after rollback failed/,
    );
    expect(live.text).toBe(BASE_CONFIG);
    expect(calls.commands).toHaveLength(2);
  });

  it("restores and restarts when applied bytes differ from the candidate", async () => {
    const { deps, calls, live } = harness(BASE_CONFIG, { corruptReadback: true });
    await expect(applyManualPromotion(spec(), deps)).rejects.toThrow(/restored backup and restarted/);
    expect(live.text).toBe(BASE_CONFIG);
    expect(calls.commands).toHaveLength(1);
  });
});
