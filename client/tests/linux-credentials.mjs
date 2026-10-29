import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  chmodSync,
  chownSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import * as client from "../m5-client.mjs";

const fixtureRoots = new Set();
const TOKEN_A = "hs_synthetic_alpha_123";
const TOKEN_B = "hs_synthetic_beta_456";

after(() => {
  for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true });
});

function requireFactories() {
  assert.equal(typeof client.createLinuxCredentialStore, "function", "m5-client must export createLinuxCredentialStore");
  assert.equal(typeof client.createPlatformCredentialStore, "function", "m5-client must export createPlatformCredentialStore");
}

function newHome() {
  const root = mkdtempSync(join(tmpdir(), "m5-linux-credentials-"));
  fixtureRoots.add(root);
  const home = join(root, "home");
  mkdirSync(home, { mode: 0o700 });
  chmodSync(home, 0o700);
  return { root, home };
}

function paths(home, profile = "default") {
  const config = join(home, ".config");
  const m5 = join(config, "m5");
  const credentials = join(m5, "credentials");
  return { config, m5, credentials, credential: join(credentials, `gateway-agent-${profile.toLowerCase()}`) };
}

function provisionDirs(home) {
  const result = paths(home);
  mkdirSync(result.config, { mode: 0o700 });
  mkdirSync(result.m5, { mode: 0o700 });
  mkdirSync(result.credentials, { mode: 0o700 });
  chmodSync(result.config, 0o700);
  chmodSync(result.m5, 0o700);
  chmodSync(result.credentials, 0o700);
  return result;
}

function provision(home, token = TOKEN_A, profile = "default", mode = 0o600) {
  const p = paths(home, profile);
  mkdirSync(p.config, { recursive: true, mode: 0o700 });
  mkdirSync(p.m5, { recursive: true, mode: 0o700 });
  mkdirSync(p.credentials, { recursive: true, mode: 0o700 });
  chmodSync(p.config, 0o700);
  chmodSync(p.m5, 0o700);
  chmodSync(p.credentials, 0o700);
  writeFileSync(p.credential, token, { mode });
  chmodSync(p.credential, mode);
  return p;
}

function restoreValidCredential(p, token = TOKEN_A) {
  rmSync(p.credential, { recursive: true, force: true });
  rmSync(join(p.credentials, "second-link"), { force: true });
  writeFileSync(p.credential, token, { mode: 0o600 });
  chmodSync(p.credential, 0o600);
}

async function assertFailure(store, profile, expectedCode, forbidden = []) {
  let caught;
  await assert.rejects(store.resolve(profile), (error) => {
    caught = error;
    assert.equal(error.code, expectedCode);
    assert.equal(typeof error.message, "string");
    return true;
  });
  for (const value of forbidden) {
    assert.equal(caught.message.includes(value), false, `error text leaked ${value}`);
  }
  assert.doesNotMatch(caught.message, /(?:\/home\/|\/tmp\/|\/Users\/|hs_[A-Za-z0-9_-]+)/);
}

test("Linux credential store exports the required API and reads a synthetic profile token", async () => {
  requireFactories();
  const { home } = newHome();
  provision(home);
  const store = client.createLinuxCredentialStore({ home, uid: process.getuid() });
  assert.equal(await store.resolve("default"), TOKEN_A);
});

test("profile validation happens before filesystem lookup and profile names stay isolated", async () => {
  requireFactories();
  const { home } = newHome();
  provision(home, TOKEN_A, "default");
  provision(home, TOKEN_B, "other");
  const store = client.createLinuxCredentialStore({ home, uid: process.getuid() });
  assert.equal(await store.resolve("DEFAULT"), TOKEN_A);
  assert.equal(await store.resolve("other"), TOKEN_B);
  for (const invalid of ["", "../default", ".hidden", "1profile", "a".repeat(33), "has space", undefined, null, {}, 42]) {
    assert.equal(await store.resolve("default"), TOKEN_A);
    await assertFailure(store, invalid, "invalid_profile");
  }
});

test("missing credentials report missing_credential and recover after provisioning", async () => {
  requireFactories();
  const { home } = newHome();
  const store = client.createLinuxCredentialStore({ home, uid: process.getuid() });
  await assertFailure(store, "default", "missing_credential");
  const p = provision(home, TOKEN_A);
  assert.equal(await store.resolve("default"), TOKEN_A);
  writeFileSync(p.credential, "", { mode: 0o600 });
  chmodSync(p.credential, 0o600);
  await assertFailure(store, "default", "missing_credential");
});

test("only a token with an optional single LF or CRLF is accepted", async (t) => {
  requireFactories();
  const { home } = newHome();
  const p = provision(home);
  const store = client.createLinuxCredentialStore({ home, uid: process.getuid() });
  for (const [content, accepted] of [[TOKEN_A, TOKEN_A], [`${TOKEN_A}\n`, TOKEN_A], [`${TOKEN_A}\r\n`, TOKEN_A]]) {
    writeFileSync(p.credential, content, { mode: 0o600 });
    chmodSync(p.credential, 0o600);
    assert.equal(await store.resolve("default"), accepted);
  }
  for (const malformed of [
    "not-a-token",
    ` ${TOKEN_A}`,
    `${TOKEN_A} `,
    `${TOKEN_A}\n\n`,
    `${TOKEN_A}\r`,
    `${TOKEN_A}\nsecond-line`,
    `${TOKEN_A}\t`,
    `hs_${"x".repeat(5000)}`,
  ]) {
    await t.test(`rejects malformed content (${malformed.length} chars)`, async () => {
      restoreValidCredential(p);
      assert.equal(await store.resolve("default"), TOKEN_A);
      writeFileSync(p.credential, malformed, { mode: 0o600 });
      chmodSync(p.credential, 0o600);
      await assertFailure(store, "default", "credential_unavailable", [malformed]);
    });
  }
  restoreValidCredential(p);
  assert.equal(await store.resolve("default"), TOKEN_A);
  writeFileSync(p.credential, Buffer.from([0x68, 0x73, 0x5f, 0xff]), { mode: 0o600 });
  chmodSync(p.credential, 0o600);
  await assertFailure(store, "default", "credential_unavailable");
});

test("credential errors redact paths and token material from messages and JSON diagnostics", async () => {
  requireFactories();
  const { home } = newHome();
  const p = provision(home, `${TOKEN_A} `);
  const store = client.createLinuxCredentialStore({ home, uid: process.getuid() });
  let caught;
  await assert.rejects(store.resolve("default"), (error) => {
    caught = error;
    assert.equal(error.code, "credential_unavailable");
    assert.equal(error.message.includes(home), false);
    assert.equal(error.message.includes(TOKEN_A), false);
    return true;
  });
  const diagnostic = JSON.stringify(caught);
  assert.equal(diagnostic.includes(home), false);
  assert.equal(diagnostic.includes(p.credential), false);
  assert.equal(diagnostic.includes(TOKEN_A), false);
  assert.equal(diagnostic.includes("credential_unavailable"), true);
});

test("home and credential directories must have safe ownership modes and no symlink components", async (t) => {
  requireFactories();
  const uid = process.getuid();
  for (const [label, mutate] of [
    ["home group writable", (home) => chmodSync(home, 0o770)],
    ["config other writable", (home) => chmodSync(paths(home).config, 0o707)],
    ["m5 group writable", (home) => chmodSync(paths(home).m5, 0o770)],
    ["credentials not private", (home) => chmodSync(paths(home).credentials, 0o755)],
  ]) {
    await t.test(label, async () => {
      const { home } = newHome();
      const p = provision(home);
      assert.equal(await client.createLinuxCredentialStore({ home, uid }).resolve("default"), TOKEN_A);
      mutate(home);
      await assertFailure(client.createLinuxCredentialStore({ home, uid }), "default", "credential_unavailable");
      chmodSync(p.config, 0o700);
      chmodSync(p.m5, 0o700);
      chmodSync(p.credentials, 0o700);
    });
  }
  for (const component of ["config", "m5", "credentials"]) {
    await t.test(`${component} symlink`, async () => {
      const { root, home } = newHome();
      const p = provision(home);
      assert.equal(await client.createLinuxCredentialStore({ home, uid }).resolve("default"), TOKEN_A);
      const target = join(root, `${component}-target`);
      mkdirSync(target, { mode: 0o700 });
      const componentPath = p[component];
      rmSync(componentPath, { recursive: true, force: true });
      symlinkSync(target, componentPath, "dir");
      await assertFailure(client.createLinuxCredentialStore({ home, uid }), "default", "credential_unavailable");
    });
  }
  await t.test("home symlink", async () => {
    const { root, home } = newHome();
    provision(home);
    assert.equal(await client.createLinuxCredentialStore({ home, uid }).resolve("default"), TOKEN_A);
    const homeLink = join(root, "home-link");
    symlinkSync(home, homeLink, "dir");
    await assertFailure(client.createLinuxCredentialStore({ home: homeLink, uid }), "default", "credential_unavailable");
  });
  await t.test("rejects a home owned by a different uid", async () => {
    const { home } = newHome();
    provision(home);
    await assertFailure(
      client.createLinuxCredentialStore({ home, uid: uid + 1 }),
      "default",
      "credential_unavailable",
    );
  });
  await t.test("rejects config and m5 directories owned by a different uid", async (t) => {
    if (uid !== 0) return t.skip("changing ownership of synthetic fixtures requires uid 0");
    for (const component of ["config", "m5", "credentials"]) {
      await t.test(`${component} owner`, async () => {
        const { home } = newHome();
        const p = provision(home);
        chownSync(p[component], 1, process.getgid());
        await assertFailure(client.createLinuxCredentialStore({ home, uid }), "default", "credential_unavailable");
      });
    }
  });
});

test("credential file must be regular, private, singly linked, and within size limits", async (t) => {
  requireFactories();
  const { root, home } = newHome();
  const p = provision(home);
  const store = client.createLinuxCredentialStore({ home, uid: process.getuid() });
  for (const mode of [0o640, 0o604, 0o666]) {
    await t.test(`rejects mode ${mode.toString(8)}`, async () => {
      restoreValidCredential(p);
      assert.equal(await store.resolve("default"), TOKEN_A);
      chmodSync(p.credential, mode);
      await assertFailure(store, "default", "credential_unavailable");
    });
  }
  await t.test("rejects a final symlink", async () => {
    restoreValidCredential(p);
    assert.equal(await store.resolve("default"), TOKEN_A);
    const target = join(root, "credential-target");
    writeFileSync(target, TOKEN_A, { mode: 0o600 });
    rmSync(p.credential);
    symlinkSync(target, p.credential);
    await assertFailure(store, "default", "credential_unavailable");
  });
  await t.test("rejects a hard link", async () => {
    restoreValidCredential(p);
    assert.equal(await store.resolve("default"), TOKEN_A);
    linkSync(p.credential, join(p.credentials, "second-link"));
    await assertFailure(store, "default", "credential_unavailable");
  });
  await t.test("rejects oversized content", async () => {
    restoreValidCredential(p);
    assert.equal(await store.resolve("default"), TOKEN_A);
    writeFileSync(p.credential, `hs_${"x".repeat(4094)}`, { mode: 0o600 });
    chmodSync(p.credential, 0o600);
    await assertFailure(store, "default", "credential_unavailable");
  });
  await t.test("accepts exactly 4096 bytes", async () => {
    restoreValidCredential(p);
    const token = `hs_${"x".repeat(4093)}`;
    writeFileSync(p.credential, token, { mode: 0o600 });
    chmodSync(p.credential, 0o600);
    assert.equal(Buffer.byteLength(token), 4096);
    assert.equal(await store.resolve("default"), token);
  });
  await t.test("rejects 4097 bytes", async () => {
    restoreValidCredential(p);
    assert.equal(await store.resolve("default"), TOKEN_A);
    const token = `hs_${"x".repeat(4094)}`;
    writeFileSync(p.credential, token, { mode: 0o600 });
    chmodSync(p.credential, 0o600);
    assert.equal(Buffer.byteLength(token), 4097);
    await assertFailure(store, "default", "credential_unavailable");
  });
  await t.test("rejects a credential owned by a different uid", async (t) => {
    if (process.getuid() !== 0) return t.skip("changing ownership of synthetic fixtures requires uid 0");
    restoreValidCredential(p);
    assert.equal(await store.resolve("default"), TOKEN_A);
    chownSync(p.credential, 1, process.getgid());
    await assertFailure(store, "default", "credential_unavailable");
  });
  await t.test("rejects a directory in place of the credential", async () => {
    restoreValidCredential(p);
    assert.equal(await store.resolve("default"), TOKEN_A);
    rmSync(p.credential, { recursive: true, force: true });
    mkdirSync(p.credential, { mode: 0o700 });
    await assertFailure(store, "default", "credential_unavailable");
  });
});

test("FIFO credential lookup is nonblocking and fails closed within a bounded subprocess", async () => {
  requireFactories();
  const { home } = newHome();
  const p = provisionDirs(home);
  execFileSync("mkfifo", [p.credential], { timeout: 1_000, stdio: "ignore" });
  const source = `
    import { createLinuxCredentialStore } from ${JSON.stringify(new URL("../m5-client.mjs", import.meta.url).href)};
    try { await createLinuxCredentialStore({ home: ${JSON.stringify(home)}, uid: ${process.getuid()} }).resolve("default"); process.exitCode = 3; }
    catch (error) { process.stdout.write(String(error.code)); }
  `;
  const result = execFileSync(process.execPath, ["--input-type=module", "-e", source], {
    timeout: 1_500,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result, "credential_unavailable");
});

test("platform factory selects Linux files, retains macOS Keychain lookup, and rejects unknown systems", async (t) => {
  requireFactories();
  const { home } = newHome();
  provision(home);
  const linuxExecFile = () => assert.fail("Linux credential resolution must not execute a command");
  const linux = client.createPlatformCredentialStore({
    platform: "linux",
    home,
    uid: process.getuid(),
    execFile: linuxExecFile,
  });
  assert.equal(await linux.resolve("default"), TOKEN_A);

  let keychainCall;
  const mac = client.createPlatformCredentialStore({
    platform: "darwin",
    execFile(command, args, options, callback) {
      keychainCall = { command, args, options };
      callback(null, `${TOKEN_B}\n`);
    },
  });
  assert.equal(await mac.resolve("Work"), TOKEN_B);
  assert.deepEqual(keychainCall, {
    command: "security",
    args: ["find-generic-password", "-s", "gille-inference", "-a", "gateway-agent-work", "-w"],
    options: { encoding: "utf8", maxBuffer: 4096, timeout: 5000, killSignal: "SIGTERM" },
  });

  const missing = client.createPlatformCredentialStore({
    platform: "darwin",
    execFile(_command, _args, _options, callback) {
      const error = new Error("synthetic Keychain item not found");
      error.code = 44;
      callback(error, "");
    },
  });
  await assertFailure(missing, "default", "missing_credential");
  const macDiagnostic = await client.diagnoseProfile({
    profile: "default", profileConfig: { publicGatewayUrl: "https://gateway.fixture.invalid" },
    credentialStore: missing, fetch: () => assert.fail("missing Keychain must not reach gateway"),
  });
  assert.equal(macDiagnostic.auth_layer, "profile_keychain");

  await t.test("unsupported platform fails closed without invoking a command", async () => {
    let invoked = false;
    const unsupported = client.createPlatformCredentialStore({
      platform: "freebsd",
      execFile() { invoked = true; },
    });
    await assert.rejects(unsupported.resolve("default"), (error) => {
      assert.equal(typeof error.code, "string");
      assert.equal(error.code, "credential_unavailable");
      assert.doesNotMatch(error.message, /freebsd|\/|hs_/i);
      return true;
    });
    assert.equal(invoked, false);
    const diagnostic = await client.diagnoseProfile({
      profile: "default", profileConfig: { publicGatewayUrl: "https://gateway.fixture.invalid" },
      credentialStore: unsupported, fetch: () => assert.fail("unsupported store must not reach gateway"),
    });
    assert.equal(diagnostic.auth_layer, "profile_credential");
  });
});
