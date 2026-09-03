import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { closeDb, initDb } from "../src/db.js";
import { recordFeedback } from "../src/homeserver/feedback.js";

const REPOSITORY_ROOT = resolve(__dirname, "..");

const originalNodeEnv = process.env["NODE_ENV"];
const originalEvalDbPath = process.env["EVAL_DB_PATH"];
const originalFeedbackPath = process.env["HOMESERVER_FEEDBACK_FILE"];

afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env["NODE_ENV"];
  else process.env["NODE_ENV"] = originalNodeEnv;
  if (originalEvalDbPath === undefined) delete process.env["EVAL_DB_PATH"];
  else process.env["EVAL_DB_PATH"] = originalEvalDbPath;
  if (originalFeedbackPath === undefined) delete process.env["HOMESERVER_FEEDBACK_FILE"];
  else process.env["HOMESERVER_FEEDBACK_FILE"] = originalFeedbackPath;
});

describe("test runtime store isolation", () => {
  it("refuses an implicit SQLite default in the test runtime", () => {
    process.env["NODE_ENV"] = "test";
    delete process.env["EVAL_DB_PATH"];
    const defaultPath = resolve("./data/eval.db");
    const existedBefore = existsSync(defaultPath);

    expect(() => initDb()).toThrow(/EVAL_DB_PATH|explicit database path/i);
    expect(existsSync(defaultPath)).toBe(existedBefore);
  });

  it("refuses an implicit feedback default in the test runtime", () => {
    process.env["NODE_ENV"] = "test";
    delete process.env["HOMESERVER_FEEDBACK_FILE"];
    const defaultPath = resolve("./data/feedback.jsonl");
    const existedBefore = existsSync(defaultPath);

    expect(() => recordFeedback({
      text: "test isolation probe",
      alias: null,
      userAgent: null,
      page: null,
    })).toThrow(/HOMESERVER_FEEDBACK_FILE|explicit feedback path/i);
    expect(existsSync(defaultPath)).toBe(existedBefore);
  });

  it("refuses repository data paths even when a test explicitly configures them", () => {
    process.env["NODE_ENV"] = "test";
    process.env["EVAL_DB_PATH"] = "./data/explicit-test.db";
    expect(() => initDb()).toThrow(/repository.*data/i);

    process.env["HOMESERVER_FEEDBACK_FILE"] = "./data/explicit-feedback.jsonl";
    expect(() => recordFeedback({
      text: "test isolation probe",
      alias: null,
      userAgent: null,
      page: null,
    })).toThrow(/repository.*data/i);
  });

  it("refuses repository data reached through a symlink", () => {
    process.env["NODE_ENV"] = "test";
    const root = mkdtempSync(join(tmpdir(), "gille-runtime-symlink-"));
    try {
      const repositoryLink = join(root, "repository");
      symlinkSync(REPOSITORY_ROOT, repositoryLink, "dir");
      process.env["EVAL_DB_PATH"] = join(repositoryLink, "data", "symlink-test.db");
      expect(() => initDb()).toThrow(/repository.*data/i);

      process.env["HOMESERVER_FEEDBACK_FILE"] = join(repositoryLink, "data", "symlink-feedback.jsonl");
      expect(() => recordFeedback({
        text: "test isolation probe",
        alias: null,
        userAgent: null,
        page: null,
      })).toThrow(/repository.*data/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("anchors the repository data check when the caller changes cwd", () => {
    process.env["NODE_ENV"] = "test";
    const root = mkdtempSync(join(tmpdir(), "gille-runtime-cwd-"));
    const originalCwd = process.cwd();
    try {
      process.chdir(root);
      process.env["EVAL_DB_PATH"] = join(REPOSITORY_ROOT, "data", "cwd-test.db");
      expect(() => initDb()).toThrow(/repository.*data/i);

      process.env["HOMESERVER_FEEDBACK_FILE"] = join(REPOSITORY_ROOT, "data", "cwd-feedback.jsonl");
      expect(() => recordFeedback({
        text: "test isolation probe",
        alias: null,
        userAgent: null,
        page: null,
      })).toThrow(/repository.*data/i);
    } finally {
      process.chdir(originalCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("allows explicit throwaway paths in the test runtime", () => {
    process.env["NODE_ENV"] = "test";
    const root = mkdtempSync(join(tmpdir(), "gille-runtime-isolation-"));
    try {
      initDb(join(root, "eval.db"));
      closeDb();
      process.env["HOMESERVER_FEEDBACK_FILE"] = join(root, "feedback.jsonl");
      expect(recordFeedback({
        text: "explicit path",
        alias: null,
        userAgent: null,
        page: null,
      })).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
