import { z } from "zod";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const installProducerIdentitySchema = z.object({
  producerId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  instanceSha256: sha256Schema,
  buildSha256: sha256Schema,
  configSha256: sha256Schema,
}).strict();

export type InstallProducerIdentity = z.infer<typeof installProducerIdentitySchema>;

const countSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();

export const installProducerSnapshotSchema = installProducerIdentitySchema.extend({
  active: countSchema,
  queued: countSchema,
  loading: countSchema,
  workStarted: countSchema,
}).strict();

export type InstallProducerSnapshot = z.infer<typeof installProducerSnapshotSchema>;

type InstallProducerStage = "queued" | "active" | "loading";
type InstallProducerHandle = {
  transition(stage: InstallProducerStage): void;
  finish(): void;
};
type ActivityRecord = { stage: InstallProducerStage; finished: boolean };
type InstallProducerActivityOptions = {
  maxTrackedWork?: number;
  maxSequence?: number;
};

const defaultMaxTrackedWork = 4096;
const defaultMaxSequence = Number.MAX_SAFE_INTEGER;
const stageNames = new Set<InstallProducerStage>(["queued", "active", "loading"]);

const optionsSchema = z.object({
  maxTrackedWork: z.number().int().positive().max(defaultMaxTrackedWork).optional(),
  maxSequence: z.number().int().positive().max(defaultMaxSequence).optional(),
}).strict();

function isStage(value: unknown): value is InstallProducerStage {
  return typeof value === "string" && stageNames.has(value as InstallProducerStage);
}

export class InstallProducerActivity {
  private readonly identity: InstallProducerIdentity;
  private readonly maxTrackedWork: number;
  private readonly maxSequence: number;
  private readonly records = new Set<ActivityRecord>();
  private active = 0;
  private queued = 0;
  private loading = 0;
  private workStarted = 0;
  private unknown = false;
  private fault: string | null = null;

  constructor(identity: unknown, options: InstallProducerActivityOptions = {}) {
    const parsedIdentity = installProducerIdentitySchema.safeParse(identity);
    if (!parsedIdentity.success) throw new Error("invalid producer identity");
    const parsedOptions = optionsSchema.safeParse(options);
    if (!parsedOptions.success) throw new Error("invalid producer activity options");
    this.identity = { ...parsedIdentity.data };
    this.maxTrackedWork = parsedOptions.data.maxTrackedWork ?? defaultMaxTrackedWork;
    this.maxSequence = parsedOptions.data.maxSequence ?? defaultMaxSequence;
  }

  begin(stage: InstallProducerStage): InstallProducerHandle {
    this.assertKnown();
    if (!isStage(stage)) this.fail("invalid producer activity stage");
    if (this.records.size >= this.maxTrackedWork) this.fail("tracked work capacity exceeded");
    if (this.workStarted >= this.maxSequence) this.fail("work start sequence overflow");

    this.workStarted += 1;
    const record: ActivityRecord = { stage, finished: false };
    this.records.add(record);
    this.changeCount(stage, 1);
    this.assertInvariant();

    return {
      transition: (nextStage: InstallProducerStage) => this.transition(record, nextStage),
      finish: () => this.finish(record),
    };
  }

  async track<T>(stage: InstallProducerStage, asyncFunction: () => PromiseLike<T> | T): Promise<T> {
    let handle: InstallProducerHandle | undefined;
    try { handle = this.begin(stage); }
    catch (error) {
      // Accounting failure revokes installation evidence, not the underlying inference operation.
      // Only deliberately latched telemetry faults are absorbed; retain their closed diagnostic.
      if (!this.unknown) throw error;
    }
    try {
      return await asyncFunction();
    } finally {
      try { handle?.finish(); }
      catch (error) { if (!this.unknown) throw error; }
    }
  }

  /** Closed instrumentation diagnostic; never includes request content or arbitrary input. */
  failureReason(): string | null { return this.fault; }

  snapshot(): InstallProducerSnapshot {
    if (this.unknown) {
      return {
        ...this.identity,
        active: null,
        queued: null,
        loading: null,
        workStarted: null,
      };
    }
    return {
      ...this.identity,
      active: this.active,
      queued: this.queued,
      loading: this.loading,
      workStarted: this.workStarted,
    };
  }

  private assertKnown(): void {
    if (this.unknown) throw new Error("producer activity is unknown");
  }

  private transition(record: ActivityRecord, nextStage: InstallProducerStage): void {
    this.assertKnown();
    if (record.finished || !this.records.has(record) || !isStage(nextStage)) {
      this.fail("invalid producer activity transition");
    }
    if (record.stage === nextStage) return;
    this.changeCount(record.stage, -1);
    this.changeCount(nextStage, 1);
    record.stage = nextStage;
    this.assertInvariant();
  }

  private finish(record: ActivityRecord): void {
    if (record.finished) return;
    if (this.unknown) {
      record.finished = true;
      return;
    }
    if (!this.records.delete(record)) this.fail("producer activity invariant failure");
    record.finished = true;
    this.changeCount(record.stage, -1);
    this.assertInvariant();
  }

  private changeCount(stage: InstallProducerStage, delta: 1 | -1): void {
    if (stage === "active") this.active += delta;
    else if (stage === "queued") this.queued += delta;
    else this.loading += delta;
  }

  private assertInvariant(): void {
    if (this.active < 0 || this.queued < 0 || this.loading < 0 ||
        this.workStarted < 0 || !Number.isSafeInteger(this.workStarted) ||
        this.records.size > this.maxTrackedWork ||
        this.active + this.queued + this.loading !== this.records.size) {
      this.fail("producer activity invariant failure");
    }
  }

  private fail(message: string): never {
    this.fault ??= message;
    this.unknown = true;
    this.records.clear();
    throw new Error(message);
  }
}
