import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { AdmissionController } from "../../src/homeserver/admission.js";
import { loadConfig } from "../../src/homeserver/config.js";
import {
  createLearningTaskCapabilityEpoch,
  type LearningTaskCapabilityEpoch,
} from "../../src/homeserver/learning-task-contract.js";
import {
  handleRequest,
  initializeGatewayRegistries,
  isImplicitAdminAllowed,
} from "../../src/homeserver/gateway.js";

export interface DirectGatewayInvokeArgs {
  method: string;
  path: string;
  token?: string;
  headers?: Record<string, string>;
  body?: string | Record<string, unknown>;
}

export interface DirectGatewayResult {
  status: number;
  headers: Record<string, string>;
  text: string;
  json: unknown | null;
}

export interface DirectGatewayHarness {
  invoke(args: DirectGatewayInvokeArgs): Promise<DirectGatewayResult>;
}

class MockServerResponse {
  public statusCode = 200;
  public headersSent = false;
  private readonly headers = new Map<string, string>();
  private readonly chunks: Buffer[] = [];

  setHeader(name: string, value: unknown): this {
    this.headers.set(name.toLowerCase(), String(value));
    return this;
  }

  getHeader(name: string): string | undefined {
    return this.headers.get(name.toLowerCase());
  }

  writeHead(status: number, headers?: Record<string, string>): this {
    this.statusCode = status;
    this.headersSent = true;
    if (headers) {
      for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    }
    return this;
  }

  write(chunk: string | Buffer): boolean {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return true;
  }

  end(chunk?: string | Buffer): this {
    if (chunk !== undefined) this.write(chunk);
    this.headersSent = true;
    return this;
  }

  bodyText(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }

  headerObject(): Record<string, string> {
    return Object.fromEntries(this.headers.entries());
  }
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function makeRequest(args: DirectGatewayInvokeArgs): IncomingMessage {
  const payload =
    typeof args.body === "string"
      ? args.body
      : args.body === undefined
        ? null
        : JSON.stringify(args.body);
  const headers: Record<string, string> = Object.fromEntries(
    Object.entries(args.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value])
  );
  if (args.token) headers["authorization"] = `Bearer ${args.token}`;
  if (payload !== null && headers["content-length"] === undefined) {
    headers["content-length"] = String(Buffer.byteLength(payload));
  }
  const req = Readable.from(payload === null ? [] : [Buffer.from(payload)]) as Readable & {
    method?: string;
    url?: string;
    headers?: Record<string, string>;
    socket?: { remoteAddress?: string };
  };
  req.method = args.method;
  req.url = args.path;
  req.headers = headers;
  req.socket = { remoteAddress: "127.0.0.1" };
  return req as IncomingMessage;
}

export function createDirectGatewayHarness(): DirectGatewayHarness {
  initializeGatewayRegistries();
  const cfg = loadConfig();
  const controller = new AdmissionController({
    maxInflight: cfg.maxInflight,
    ownerQueueMaxMs: cfg.ownerQueueMaxMs,
    retryAfterAtCapSeconds: cfg.busyRetryAfterSeconds,
    maintenanceRetryAfterSeconds: cfg.maintenanceRetryAfterSeconds,
    maintenanceMode: cfg.maintenanceModeAtStart,
  });
  const learningTaskCapabilityEpoch: LearningTaskCapabilityEpoch = createLearningTaskCapabilityEpoch();
  const implicitAdminAllowed = isImplicitAdminAllowed(cfg, isLoopbackHost(cfg.gatewayHost));

  return {
    async invoke(args: DirectGatewayInvokeArgs): Promise<DirectGatewayResult> {
      const req = makeRequest(args);
      const res = new MockServerResponse();
      await handleRequest(
        req,
        res as unknown as ServerResponse,
        cfg,
        controller,
        implicitAdminAllowed,
        learningTaskCapabilityEpoch,
      );
      const text = res.bodyText();
      let json: unknown | null = null;
      if (text !== "") {
        try {
          json = JSON.parse(text) as unknown;
        } catch {
          json = null;
        }
      }
      return {
        status: res.statusCode,
        headers: res.headerObject(),
        text,
        json,
      };
    },
  };
}
