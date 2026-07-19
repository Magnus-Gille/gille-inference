/**
 * Thin wrapper around the image-generation sidecar's HTTP API. Both the synchronous fast-tier
 * handler and the async worker call THIS — it is the single place that knows the backend protocol,
 * so swapping sd-server (HIP) for a Vulkan fallback is a one-file change.
 *
 * Protocol: POST {url}/v1/images/generations with an OpenAI-shaped body, expecting
 * {created, data: [{b64_json}, ...]}. We implement async semantics at the GATEWAY (queue + worker),
 * not by delegating to a backend job manager, so this call is always a single blocking request.
 */

export interface SidecarRequest {
  prompt: string;
  /** Backend model id (the concrete sd-server model, not the advertised image-* alias). */
  model: string;
  n: number;
  size: string;
}

/** Distinguish a backend-down/timeout fault (→ refund + 502/504) from a programming error. */
export class ImageSidecarError extends Error {
  constructor(
    message: string,
    public kind: "upstream_unavailable" | "upstream_timeout" | "bad_response"
  ) {
    super(message);
    this.name = "ImageSidecarError";
  }
}

interface SidecarResponse {
  data?: Array<{ b64_json?: unknown }>;
}

/**
 * Generate `req.n` images. Returns the array of base64-encoded PNGs (length n on success).
 * `timeoutMs` bounds the call; an optional external `signal` (job cancel) aborts it early.
 * Throws ImageSidecarError on any backend fault so the caller can refund + map a clean status.
 */
export async function generateImages(
  url: string,
  req: SidecarRequest,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<string[]> {
  const timeout = AbortSignal.timeout(timeoutMs);
  // Combine the per-call timeout with an optional external cancel signal.
  const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;

  let resp: Response;
  try {
    resp = await fetch(`${url}/v1/images/generations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: req.prompt, model: req.model, n: req.n, size: req.size, response_format: "b64_json" }),
      signal: combined,
    });
  } catch (err) {
    // An aborted external signal surfaces as the caller's cancel — re-throw so the worker sees it.
    if (signal?.aborted) throw err;
    if (timeout.aborted) throw new ImageSidecarError("image sidecar timed out", "upstream_timeout");
    throw new ImageSidecarError(`image sidecar unreachable: ${String(err)}`, "upstream_unavailable");
  }

  if (resp.status >= 400) {
    throw new ImageSidecarError(`image sidecar returned ${resp.status}`, "upstream_unavailable");
  }

  let parsed: SidecarResponse;
  try {
    parsed = (await resp.json()) as SidecarResponse;
  } catch {
    throw new ImageSidecarError("image sidecar returned a non-JSON body", "bad_response");
  }

  const data = Array.isArray(parsed.data) ? parsed.data : null;
  if (!data || data.length === 0) {
    throw new ImageSidecarError("image sidecar returned no images", "bad_response");
  }
  const b64 = data
    .map((d) => (typeof d.b64_json === "string" ? d.b64_json : null))
    .filter((s): s is string => s !== null);
  if (b64.length === 0) {
    throw new ImageSidecarError("image sidecar returned no b64_json data", "bad_response");
  }
  // Enforce the documented "length n" contract. A misbehaving sidecar that returns MORE images
  // than requested must never over-bill — both the sync and async billing paths charge by the
  // returned count, and only `n × creditsPerImage` was reserved.
  return b64.slice(0, req.n);
}
