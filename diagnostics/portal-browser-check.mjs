#!/usr/bin/env node

// Disposable visual verification for portal-preview.mjs. This uses only Node 22's built-in
// WebSocket and Chrome DevTools Protocol; it never installs or locates a browser implicitly.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");
const previewScript = join(dirname(scriptPath), "portal-preview.mjs");
const states = ["normal", "missing", "error"];
const viewports = {
  desktop: { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false },
  mobile: { width: 390, height: 844, deviceScaleFactor: 1, mobile: true },
};
const expectedApiStatuses = {
  normal: { stats: 200, evals: 200 },
  missing: { stats: 200, evals: 200 },
  error: { stats: 503, evals: 200 },
};
const fixtureLine = /^([a-z]+): actual gateway \/portal 200, stats (\d{3}), model-evals (\d{3})$/m;
const previewUrlLine = /^Preview URL: (http:\/\/127\.0\.0\.1:\d+\/portal)$/m;
const CDP_TIMEOUT_MS = 10_000;
const START_TIMEOUT_MS = 20_000;
const FIXTURE_TIMEOUT_MS = 30_000;
const PROCESS_STOP_TIMEOUT_MS = 5_000;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseActivePort(contents) {
  const [portLine, pathLine, ...extra] = String(contents).trim().split(/\r?\n/);
  const port = Number(portLine);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || extra.length !== 0 ||
      typeof pathLine !== "string" || !/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(pathLine)) {
    throw new Error("Chrome DevToolsActivePort contained an invalid loopback endpoint");
  }
  return { port, path: pathLine };
}

function parseArgs(argv) {
  const options = { check: false, browser: null, outputDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--check") options.check = true;
    else if (arg === "--browser" && argv[i + 1]) options.browser = argv[++i];
    else if (arg === "--output-dir" && argv[i + 1]) options.outputDir = argv[++i];
    else throw new Error(`unknown or incomplete argument: ${arg}`);
  }
  if (!options.check && (!options.browser || !options.outputDir)) {
    throw new Error("usage: node diagnostics/portal-browser-check.mjs --browser /absolute/chrome --output-dir /absolute/new-output-dir");
  }
  if (!options.check && (!options.browser.startsWith("/") || !options.outputDir.startsWith("/"))) {
    throw new Error("--browser and --output-dir must be absolute paths");
  }
  return options;
}

function parserCheck() {
  assert.deepEqual(parseActivePort("9223\n/devtools/browser/ab12-CD34\n"), {
    port: 9223, path: "/devtools/browser/ab12-CD34",
  });
  for (const invalid of [
    "0\n/devtools/browser/id\n", "9223\n/devtools/page/id\n", "9223\n/devtools/browser/id\nextra\n",
  ]) assert.throws(() => parseActivePort(invalid));
  assert.deepEqual(parseArgs(["--browser", "/usr/bin/chromium", "--output-dir", "/tmp/portal-check"]), {
    check: false, browser: "/usr/bin/chromium", outputDir: "/tmp/portal-check",
  });
  assert.equal(parseArgs(["--check"]).check, true);
  assert.throws(() => parseArgs(["--browser", "relative", "--output-dir", "/tmp/out"]));
  console.log("CDP endpoint and argument parser checks passed");
}

function waitForEvent(target, eventName, timeoutMs, failIf = () => false) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => finish(new Error(`timed out waiting for ${eventName}`)), timeoutMs);
    const onEvent = (event) => {
      if (failIf(event)) return finish(new Error(`${eventName} wait interrupted`));
      finish(null, event);
    };
    const onError = (error) => finish(error);
    const finish = (error, event) => {
      clearTimeout(timeout);
      target.off(eventName, onEvent);
      target.off("socketError", onError);
      if (error) rejectPromise(error);
      else resolvePromise(event);
    };
    target.on(eventName, onEvent);
    target.on("socketError", onError);
  });
}

class CdpConnection {
  #socket;
  #nextId = 0;
  #pending = new Map();
  #listeners = new Map();

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data));
        if (Number.isInteger(message.id)) {
          const pending = this.#pending.get(message.id);
          if (!pending) return;
          clearTimeout(pending.timeout);
          this.#pending.delete(message.id);
          if (message.error) pending.reject(new Error(`CDP ${pending.method}: ${message.error.message}`));
          else pending.resolve(message.result ?? {});
          return;
        }
        for (const callback of this.#listeners.get(message.method) ?? []) callback(message.params ?? {});
      } catch (error) {
        this.#emit("socketError", error instanceof Error ? error : new Error("invalid CDP message"));
      }
    });
    socket.addEventListener("error", () => this.#emit("socketError", new Error("CDP WebSocket error")));
    socket.addEventListener("close", () => {
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("CDP WebSocket closed"));
      }
      this.#pending.clear();
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => rejectPromise(new Error("CDP WebSocket open timed out")), CDP_TIMEOUT_MS);
      socket.addEventListener("open", () => { clearTimeout(timeout); resolvePromise(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timeout); rejectPromise(new Error("CDP WebSocket connection failed")); }, { once: true });
    });
    return new CdpConnection(socket);
  }

  on(name, callback) {
    const callbacks = this.#listeners.get(name) ?? new Set();
    callbacks.add(callback);
    this.#listeners.set(name, callbacks);
  }

  off(name, callback) {
    this.#listeners.get(name)?.delete(callback);
  }

  #emit(name, value) {
    for (const callback of this.#listeners.get(name) ?? []) callback(value);
  }

  command(method, params = {}) {
    if (this.#socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("CDP WebSocket is not open"));
    const id = ++this.#nextId;
    return new Promise((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        rejectPromise(new Error(`CDP command timed out: ${method}`));
      }, CDP_TIMEOUT_MS);
      this.#pending.set(id, { method, timeout, resolve: resolvePromise, reject: rejectPromise });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    if (this.#socket.readyState === WebSocket.OPEN || this.#socket.readyState === WebSocket.CONNECTING) {
      this.#socket.close();
    }
  }
}

function appendBounded(current, chunk, limit = 12_000) {
  return (current + chunk.toString()).slice(-limit);
}

async function waitForChildOutput(child, readOutput, pattern, timeoutMs, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const output = readOutput();
    const match = output.match(pattern);
    if (match) return match;
    if (child.spawnError) throw new Error(`${label} failed to start: ${child.spawnError.message}`);
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${label} exited before ready (${child.exitCode ?? child.signalCode})\n${output.slice(-2000)}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`${label} did not become ready within ${timeoutMs} ms\n${readOutput().slice(-2000)}`);
}

async function terminateProcess(child, label) {
  if (!child.pid) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32" || !child.pid) child.kill("SIGTERM");
    else process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  const exited = await Promise.race([
    new Promise((resolvePromise) => child.once("exit", () => resolvePromise(true))),
    new Promise((resolvePromise) => setTimeout(() => resolvePromise(false), PROCESS_STOP_TIMEOUT_MS)),
  ]);
  if (!exited && child.exitCode === null && child.signalCode === null) {
    try {
      if (process.platform === "win32" || !child.pid) child.kill("SIGKILL");
      else process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
    await Promise.race([
      new Promise((resolvePromise) => child.once("exit", resolvePromise)),
      new Promise((_, rejectPromise) => setTimeout(() => rejectPromise(new Error(`${label} would not stop`)), PROCESS_STOP_TIMEOUT_MS)),
    ]);
  }
}

async function startPreview(state, scratch) {
  const output = { stdout: "", stderr: "" };
  mkdirSync(join(scratch, "preview-home"), { recursive: true, mode: 0o700 });
  mkdirSync(join(scratch, "preview-tmp"), { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, ["--import", "tsx", previewScript, "--state", state, "--port", "0"], {
    cwd: repoRoot,
    detached: process.platform !== "win32",
    env: {
      PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
      HOME: join(scratch, "preview-home"),
      TMPDIR: join(scratch, "preview-tmp"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.on("error", (error) => { output.spawnError = error; });
  child.stdout.on("data", (chunk) => { output.stdout = appendBounded(output.stdout, chunk); });
  child.stderr.on("data", (chunk) => { output.stderr = appendBounded(output.stderr, chunk); });
  try {
    await waitForChildOutput(child, () => output.stdout, previewUrlLine, FIXTURE_TIMEOUT_MS, `fixture ${state}`);
    const line = output.stdout.match(fixtureLine);
    assert.ok(line, `fixture ${state} did not report gateway/API status`);
    assert.equal(line[1], state, `fixture printed a mismatched state label for ${state}`);
    const urlMatch = output.stdout.match(previewUrlLine);
    if (!urlMatch) throw new Error(`fixture ${state} did not publish its loopback URL`);
    const apiStatuses = { stats: Number(line[2]), evals: Number(line[3]) };
    assert.deepEqual(apiStatuses, expectedApiStatuses[state], `fixture API status label mismatch for ${state}`);
    return { child, output, url: urlMatch[1], apiStatuses };
  } catch (error) {
    await terminateProcess(child, `portal fixture ${state}`);
    throw error;
  }
}

async function waitForDebugEndpoint(chrome, profileDir, output) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  const activePortFile = join(profileDir, "DevToolsActivePort");
  while (Date.now() < deadline) {
    if (output.spawnError) throw new Error(`Chrome failed to start: ${output.spawnError.message}`);
    if (chrome.exitCode !== null || chrome.signalCode !== null) {
      throw new Error(`Chrome exited before CDP startup (${chrome.exitCode ?? chrome.signalCode})\n${output.stderr.slice(-3000)}`);
    }
    if (existsSync(activePortFile)) {
      const endpoint = parseActivePort(readFileSync(activePortFile, "utf8"));
      const origin = `http://127.0.0.1:${endpoint.port}`;
      try {
        const response = await fetch(`${origin}/json/version`, { signal: AbortSignal.timeout(1_000) });
        if (!response.ok) throw new Error(`CDP version endpoint returned ${response.status}`);
        const version = await response.json();
        const wsUrl = new URL(version.webSocketDebuggerUrl);
        if (wsUrl.protocol !== "ws:" || Number(wsUrl.port) !== endpoint.port ||
            wsUrl.pathname !== endpoint.path || !["127.0.0.1", "localhost", "::1"].includes(wsUrl.hostname)) {
          throw new Error("Chrome browser WebSocket endpoint was not bound to the expected loopback port");
        }
        return { ...endpoint, origin, version };
      } catch (error) {
        if (error?.name !== "TimeoutError" && error?.cause?.code !== "ECONNREFUSED") throw error;
      }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Chrome did not create a loopback DevTools endpoint within ${START_TIMEOUT_MS} ms\n${output.stderr.slice(-3000)}`);
}

async function getPageTarget(debug) {
  const response = await fetch(`${debug.origin}/json/list`, { signal: AbortSignal.timeout(CDP_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Chrome target list returned ${response.status}`);
  const targets = await response.json();
  const target = targets.find((candidate) => candidate.type === "page" && candidate.url === "about:blank");
  if (!target?.webSocketDebuggerUrl) throw new Error("Chrome did not start a fresh about:blank page target");
  const wsUrl = new URL(target.webSocketDebuggerUrl);
  if (wsUrl.protocol !== "ws:" || Number(wsUrl.port) !== debug.port ||
      !/^\/devtools\/page\/[A-Za-z0-9-]+$/.test(wsUrl.pathname) ||
      !["127.0.0.1", "localhost", "::1"].includes(wsUrl.hostname)) {
    throw new Error("Chrome page WebSocket endpoint was not the expected loopback target");
  }
  return `ws://127.0.0.1:${debug.port}${wsUrl.pathname}`;
}

async function evaluate(cdp, expression) {
  const result = await cdp.command("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(`page evaluation failed: ${result.exceptionDetails.text || "exception"}`);
  }
  return result.result?.value;
}

async function waitForPageLoaded(cdp, url) {
  const loaded = waitForEvent(cdp, "Page.loadEventFired", 20_000);
  await cdp.command("Page.navigate", { url });
  await loaded;
}

async function waitForApiResponses(cdp, responseStatuses, expected) {
  const started = Date.now();
  while (Date.now() - started < 15_000) {
    if (responseStatuses.stats === expected.stats && responseStatuses.evals === expected.evals) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`browser API responses did not match expected state: ${JSON.stringify(responseStatuses)}`);
}

async function capturePng(cdp, filename, width, height) {
  const result = await cdp.command("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  const png = Buffer.from(result.data ?? "", "base64");
  assert.ok(png.length > 1_000, `${filename}: screenshot was empty or unexpectedly small`);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${filename}: screenshot was not PNG data`);
  assert.equal(png.toString("ascii", 12, 16), "IHDR", `${filename}: PNG header was malformed`);
  assert.equal(png.readUInt32BE(16), width, `${filename}: screenshot width did not match its viewport`);
  assert.equal(png.readUInt32BE(20), height, `${filename}: screenshot height did not match its viewport`);
  return { filename, width, height, bytes: png.length, sha256: sha256(png), png };
}

async function assertRenderedState(cdp, state, apiStatuses) {
  const value = await evaluate(cdp, `(() => {
    const state = ${JSON.stringify(state)};
    const stats = document.querySelector("#stats-card");
    const evals = document.querySelector("#evals-card");
    const text = (element) => element?.textContent?.trim() ?? "";
    return {
      urlState: new URL(location.href).searchParams.get("preview"),
      statsVisible: Boolean(stats && !stats.classList.contains("hide")),
      evalsVisible: Boolean(evals && !evals.classList.contains("hide")),
      tokens: text(document.querySelector("#stat-tokens")),
      requests: text(document.querySelector("#stat-requests")),
      evaluationText: text(document.querySelector("#evals-rows")),
      healthHistoryPresent: [...document.querySelectorAll("p")].some((p) => p.textContent.includes("historical evidence, it is not live readiness")),
      doctorHistoryPresent: [...document.querySelectorAll("p")].some((p) => p.textContent.includes("a past success does not verify this route now")),
    };
  })()`);
  assert.equal(value.urlState, state, "state label in the preview URL changed");
  if (state === "normal") {
    assert.deepEqual(apiStatuses, expectedApiStatuses.normal);
    assert.equal(value.statsVisible, true);
    assert.equal(value.evalsVisible, true);
    assert.equal(value.tokens, "4.6k");
    assert.equal(value.requests, "1");
    assert.match(value.evaluationText, /synthetic-preview-model/);
  } else if (state === "missing") {
    assert.deepEqual(apiStatuses, expectedApiStatuses.missing);
    assert.equal(value.statsVisible, true);
    assert.equal(value.evalsVisible, false);
    assert.equal(value.tokens, "0");
    assert.equal(value.requests, "0");
  } else {
    assert.deepEqual(apiStatuses, expectedApiStatuses.error);
    assert.equal(value.statsVisible, false);
    assert.equal(value.evalsVisible, false);
  }
  assert.equal(value.healthHistoryPresent, true, "health/history explanation missing from actual portal");
  assert.equal(value.doctorHistoryPresent, true, "doctor/history explanation missing from actual portal");
  return value;
}

async function scrollToExplanation(cdp, type) {
  const expression = type === "health-history"
    ? `(() => {
        const target = [...document.querySelectorAll("p")].find((p) => p.textContent.includes("historical evidence, it is not live readiness"));
        if (!target) throw new Error("historical health explanation not found");
        target.scrollIntoView({ block: "center", behavior: "instant" });
        return { section: "What's running", text: target.textContent.trim() };
      })()`
    : `(() => {
        const details = document.querySelector("#docs-section");
        const summary = details?.querySelector("summary");
        if (!details || !summary) throw new Error("How to use it disclosure not found");
        if (!details.open) summary.click();
        const target = [...details.querySelectorAll("p")].find((p) => p.textContent.includes("a past success does not verify this route now"));
        if (!target || !details.open) throw new Error("doctor history explanation could not be opened");
        target.scrollIntoView({ block: "center", behavior: "instant" });
        return { section: "MCP (Claude Code)", text: target.textContent.trim(), disclosureClicked: true };
      })()`;
  return evaluate(cdp, expression);
}

async function runViewport(cdp, state, viewportName, origin, fixtureStatuses, screenshotRecords, runtimeErrors, externalRequests) {
  const viewport = viewports[viewportName];
  await cdp.command("Emulation.setDeviceMetricsOverride", viewport);
  if (viewport.mobile) await cdp.command("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  else await cdp.command("Emulation.setTouchEmulationEnabled", { enabled: false });

  const responseStatuses = {};
  const onResponse = (event) => {
    const url = new URL(event.response.url);
    if (url.origin !== origin) return;
    if (url.pathname === "/portal/stats") responseStatuses.stats = event.response.status;
    if (url.pathname === "/portal/model-evals.json") responseStatuses.evals = event.response.status;
  };
  const onRequest = (event) => {
    try {
      const requestUrl = new URL(event.request.url);
      if (["http:", "https:"].includes(requestUrl.protocol) && requestUrl.origin !== origin) {
        externalRequests.push(event.request.url);
      }
    } catch {
      externalRequests.push("invalid-url");
    }
  };
  cdp.on("Network.responseReceived", onResponse);
  cdp.on("Network.requestWillBeSent", onRequest);

  try {
    const pageUrl = `${origin}/portal?preview=${encodeURIComponent(state)}`;
    await waitForPageLoaded(cdp, pageUrl);
    await waitForApiResponses(cdp, responseStatuses, fixtureStatuses);
    const ui = await assertRenderedState(cdp, state, responseStatuses);

    const healthSection = await scrollToExplanation(cdp, "health-history");
    await evaluate(cdp, "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    const healthName = `portal-${state}-${viewportName}-health-history.png`;
    screenshotRecords.push({ ...await capturePng(cdp, healthName, viewport.width, viewport.height), section: healthSection.section });

    const doctorSection = await scrollToExplanation(cdp, "doctor-history");
    await evaluate(cdp, "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    const doctorName = `portal-${state}-${viewportName}-doctor-history.png`;
    screenshotRecords.push({ ...await capturePng(cdp, doctorName, viewport.width, viewport.height), section: doctorSection.section });
    if (!doctorSection.disclosureClicked) throw new Error("doctor history disclosure was not clicked");

    if (runtimeErrors.length > 0) {
      throw new Error(`browser runtime exceptions in ${state}/${viewportName}: ${JSON.stringify(runtimeErrors.slice(0, 3))}`);
    }
    if (externalRequests.length > 0) {
      throw new Error(`browser requested non-fixture origins: ${JSON.stringify(externalRequests.slice(0, 3))}`);
    }
    return { url: pageUrl, viewport: viewportName, width: viewport.width, height: viewport.height, apiStatuses: responseStatuses, ui };
  } finally {
    cdp.off("Network.responseReceived", onResponse);
    cdp.off("Network.requestWillBeSent", onRequest);
  }
}

async function runCase(state, browserBinary, tempRoot) {
  const caseDir = mkdtempSync(join(tempRoot, `${state}-`));
  const profileDir = join(caseDir, "chrome-profile");
  mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  let fixture;
  let chrome;
  let cdp;
  try {
    fixture = await startPreview(state, caseDir);
    const chromeOutput = { stdout: "", stderr: "" };
    chrome = spawn(browserBinary, [
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-sync",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`,
      "about:blank",
    ], {
      detached: process.platform !== "win32",
      env: {
        PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
        HOME: profileDir,
        USERPROFILE: profileDir,
        TMPDIR: caseDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    chrome.on("error", (error) => { chromeOutput.spawnError = error; });
    chrome.stdout.on("data", (chunk) => { chromeOutput.stdout = appendBounded(chromeOutput.stdout, chunk); });
    chrome.stderr.on("data", (chunk) => { chromeOutput.stderr = appendBounded(chromeOutput.stderr, chunk); });
    const debug = await waitForDebugEndpoint(chrome, profileDir, chromeOutput);
    assert.equal(typeof debug.version.Browser, "string", "Chrome did not report its browser version");
    assert.equal(typeof debug.version["Protocol-Version"], "string", "Chrome did not report its protocol version");
    assert.equal(typeof debug.version["User-Agent"], "string", "Chrome did not report its user agent");
    const pageWs = await getPageTarget(debug);
    cdp = await CdpConnection.connect(pageWs);
    await cdp.command("Page.enable");
    await cdp.command("Runtime.enable");
    await cdp.command("Network.enable");
    const runtimeErrors = [];
    const externalRequests = [];
    cdp.on("Runtime.exceptionThrown", (event) => {
      runtimeErrors.push(event.exceptionDetails?.text || event.exceptionDetails?.exception?.description || "uncaught exception");
    });
    const screenshots = [];
    const viewResults = [];
    const origin = new URL(fixture.url).origin;
    for (const viewportName of Object.keys(viewports)) {
      viewResults.push(await runViewport(
        cdp, state, viewportName, origin, fixture.apiStatuses, screenshots, runtimeErrors, externalRequests,
      ));
    }
    if (runtimeErrors.length > 0) throw new Error(`browser runtime exceptions: ${JSON.stringify(runtimeErrors.slice(0, 3))}`);
    if (externalRequests.length > 0) throw new Error(`browser requested non-fixture origins: ${JSON.stringify(externalRequests.slice(0, 3))}`);
    return {
      state,
      fixtureUrl: fixture.url,
      fixtureOutput: fixture.output.stdout.trim().split(/\r?\n/).slice(-4),
      apiStatuses: fixture.apiStatuses,
      runtimeExceptionCount: runtimeErrors.length,
      externalRequestCount: externalRequests.length,
      views: viewResults,
      screenshots,
      browser: {
        product: debug.version.Browser,
        protocolVersion: debug.version["Protocol-Version"],
        userAgent: debug.version["User-Agent"],
        v8Version: debug.version["V8-Version"],
      },
    };
  } finally {
    cdp?.close();
    try {
      if (chrome) await terminateProcess(chrome, `Chrome ${state}`);
    } finally {
      try {
        if (fixture) await terminateProcess(fixture.child, `portal fixture ${state}`);
      } finally {
        rmSync(caseDir, { recursive: true, force: true });
      }
    }
  }
}

async function main() {
  assert.equal(Number(process.versions.node.split(".")[0]), 22, "run this utility with Node 22");
  if (process.platform === "win32") throw new Error("run this utility on POSIX CI so it can terminate each process group");
  const options = parseArgs(process.argv.slice(2));
  if (options.check) return parserCheck();
  if (!options.browser.startsWith("/")) throw new Error("--browser must be an absolute existing CI binary path");
  const browserBinary = realpathSync(options.browser);
  accessSync(browserBinary, constants.X_OK);
  const outputDir = resolve(options.outputDir);
  mkdirSync(outputDir, { recursive: true });
  if (readdirSync(outputDir).length !== 0) throw new Error("--output-dir must be empty so existing artifacts are preserved");
  const htmlPath = join(repoRoot, "src/homeserver/portal.html");
  const git = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 5_000,
    env: { PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin" },
  });
  if (git.status !== 0 || !/^[a-f0-9]{40}\s*$/.test(git.stdout)) throw new Error("could not bind receipt to a full git revision");
  const source = {
    gitSha: git.stdout.trim(),
    portalHtmlSha256: sha256(readFileSync(htmlPath)),
    fixtureScriptSha256: sha256(readFileSync(previewScript)),
    runnerScriptSha256: sha256(readFileSync(scriptPath)),
    browserBinary,
  };
  const tempRoot = mkdtempSync(join(outputDir, ".portal-browser-check-"));
  const screenshots = [];
  const cases = [];
  let complete = false;
  try {
    for (const state of states) cases.push(await runCase(state, browserBinary, tempRoot));
    for (const item of cases) {
      for (const screenshot of item.screenshots) {
        writeFileSync(join(outputDir, screenshot.filename), screenshot.png, { flag: "wx", mode: 0o600 });
        screenshots.push({
          state: item.state,
          filename: screenshot.filename,
          section: screenshot.section,
          width: screenshot.width,
          height: screenshot.height,
          bytes: screenshot.bytes,
          sha256: screenshot.sha256,
        });
      }
      delete item.screenshots;
    }
    const receipt = {
      schema: "portal-browser-check/v1",
      completedAt: new Date().toISOString(),
      nodeVersion: process.version,
      source,
      cases: cases.map(({ browser, ...rest }) => rest),
      browser: cases[0]?.browser,
      screenshots,
    };
    writeFileSync(join(outputDir, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    complete = true;
    console.log(JSON.stringify({ outputDir, source, cases: cases.map((item) => ({ state: item.state, apiStatuses: item.apiStatuses, runtimeExceptionCount: item.runtimeExceptionCount })), screenshotCount: screenshots.length }, null, 2));
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
    if (!complete) {
      for (const entry of readdirSync(outputDir)) {
        if (entry.startsWith("portal-") && entry.endsWith(".png")) rmSync(join(outputDir, entry), { force: true });
        if (entry === "receipt.json") rmSync(join(outputDir, entry), { force: true });
      }
    }
  }
}

await main();
