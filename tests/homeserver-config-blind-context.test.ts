import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, resetConfig } from "../src/homeserver/config.js";

const KEY = "HOMESERVER_BLIND_CONTEXT_ROOTS";
const MAX_BLIND_CONTEXT_ROOTS = 128;
let saved: string | undefined;

beforeEach(() => {
  saved = process.env[KEY];
  delete process.env[KEY];
  resetConfig();
});

afterEach(() => {
  if (saved === undefined) delete process.env[KEY];
  else process.env[KEY] = saved;
  resetConfig();
});

describe("HOMESERVER_BLIND_CONTEXT_ROOTS config loader", () => {
  it(`fails closed when more than ${MAX_BLIND_CONTEXT_ROOTS} roots are configured`, () => {
    process.env[KEY] = Array.from(
      { length: MAX_BLIND_CONTEXT_ROOTS + 1 },
      (_, index) => `/blind-context-root-${index}`
    ).join(":");
    resetConfig();

    expect(() => loadConfig()).toThrow(
      new RegExp(`at most ${MAX_BLIND_CONTEXT_ROOTS} entries`, "i")
    );
  });
});
