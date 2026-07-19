# Service level — Gille Inference (best effort)

This is a hobbyist endpoint running on a single home machine. By using your key
you accept the following:

1. **No uptime guarantee.** The service may be slow, restarting, or offline at any
   time without notice. Do not build anything that *needs* it to be up. There is
   no support contract and no on-call.

2. **Owner work takes priority — always.** When the owner is running a job, your
   requests may be **delayed or rejected with `503`** until owner load clears. The
   owner preempts all guest traffic.

3. **Concurrency is capped.** The box serves a small fixed number of requests at
   once (single GPU). When that cap is reached, new requests get **`503`
   `server_busy`** with a **`Retry-After`** header (seconds). Honor `Retry-After`
   and back off — do not hammer.

4. **`503` is normal, not an error in your code.** A `503` means "busy right now,
   try again shortly." It is expected under load and is *not* a sign your request
   was malformed. Retry with exponential backoff + jitter.

5. **The model set may change without notice.** Models can be added, removed,
   renamed, or swapped for different quantizations at any time. Pin nothing; check
   `GET /v1/models` if a `model` returns `400`/`403`.

6. **Fair use / quotas.** Each key has per-minute (RPM), per-minute-token (TPM),
   parallel-request, and daily-token limits. Exceeding them returns **`429`** with
   a `Retry-After`. Persistent abuse, or attempts to use the box as a bulk
   prompt-farm, gets your key revoked.

7. **No data/privacy guarantee for your inputs beyond best effort.** Prompts may
   be logged for abuse monitoring and debugging. Don't send secrets or regulated
   data.

8. **Keys are personal and revocable.** Don't share your key. Keys can be revoked
   at any time, for any reason, instantly.

*Target (aspirational, not guaranteed): owner-idle requests are usually served
promptly; first-token latency under load is best-effort. Treat everything above as
the contract; treat latency as a courtesy.*
