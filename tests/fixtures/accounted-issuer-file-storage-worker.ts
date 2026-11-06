import { openAccountedIssuerFileStorage } from "../../src/homeserver/accounted-issuer-file-storage.js";

const MAX_INPUT_BYTES = 600_000;
const DEADLINE_MS = 3_000;
const DIRECTORY_ENV = "ISSUER_TEST_DIRECTORY";
const VERSION_PATTERN = /^[0-9a-f]{64}$/;
const REQUEST_KEYS = ["action", "directory", "expectedVersion", "initialVersion", "ownerUid", "state"];

type Request = {
  action: "cas" | "read";
  directory: string;
  ownerUid: number;
  expectedVersion: unknown;
  initialVersion: string;
  state: unknown;
};

class Refused extends Error {}

function refused(): never {
  throw new Refused("refused");
}

function parseRequest(value: unknown): Request {
  if (typeof value !== "object" || value === null || Array.isArray(value)) refused();
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort();
  if (keys.length !== REQUEST_KEYS.length || !REQUEST_KEYS.every((key, index) => key === keys[index])) refused();
  if (object.action !== "cas" && object.action !== "read") refused();
  if (typeof object.directory !== "string" || object.directory.length === 0) refused();
  if (typeof object.ownerUid !== "number" || !Number.isSafeInteger(object.ownerUid) || object.ownerUid <= 0) refused();
  if (typeof object.initialVersion !== "string" || !VERSION_PATTERN.test(object.initialVersion)) refused();
  return object as Request;
}

function readStdin(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const timer = setTimeout(() => finish(new Error("deadline")), DEADLINE_MS);
    const finish = (error: Error | undefined, value?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.off("error", onError);
      if (error) reject(error);
      else resolve(value as Buffer);
    };
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > MAX_INPUT_BYTES) return finish(new Error("input_bound"));
      chunks.push(buffer);
    };
    const onEnd = () => finish(undefined, Buffer.concat(chunks, bytes));
    const onError = () => finish(new Error("input_error"));
    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
    process.stdin.once("error", onError);
  });
}

async function run(): Promise<void> {
  const actualUid = process.getuid?.();
  if (actualUid === undefined || actualUid === 0) refused();
  const pinnedDirectory = process.env[DIRECTORY_ENV];
  if (typeof pinnedDirectory !== "string" || pinnedDirectory.length === 0) refused();

  const request = parseRequest(JSON.parse((await readStdin()).toString("utf8")));
  if (request.ownerUid !== actualUid || request.directory !== pinnedDirectory) refused();
  if (request.action === "cas" && (typeof request.expectedVersion !== "string" || !VERSION_PATTERN.test(request.expectedVersion))) refused();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
  let backend: Awaited<ReturnType<typeof openAccountedIssuerFileStorage>> | undefined;
  let output: {status: "cas"; won: boolean} | {status: "read"; version: string};
  try {
    backend = await openAccountedIssuerFileStorage({
      directory: request.directory,
      ownerUid: request.ownerUid,
      initialVersion: request.initialVersion,
    });
    if (request.action === "cas") {
      const won = await backend.storage.compareAndSwap(request.expectedVersion as string, request.state, controller.signal);
      if (typeof won !== "boolean") refused();
      output = {status: "cas", won};
    } else {
      const result = await backend.storage.read(controller.signal);
      if (typeof result.version !== "string" || !VERSION_PATTERN.test(result.version)) refused();
      output = {status: "read", version: result.version};
    }
  } finally {
    clearTimeout(timer);
    if (backend !== undefined) {
      const acquired = backend;
      backend = undefined;
      await acquired.close();
    }
  }
  process.stdout.write(JSON.stringify(output) + "\n");
}

run().catch(() => {
  process.stdout.write('{"status":"refused"}\n');
  process.exitCode = 2;
});
