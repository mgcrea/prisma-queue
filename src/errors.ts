import type { PrismaJob } from "./PrismaJob";
import type { JobPayload, JobResult } from "./types";

/**
 * Raised when a job is retired because it was claimed past its `maxAttempts` without ever completing —
 * the claim was reclaimed by the stale lease (see the `reclaim` event), and re-claiming pushed `attempts`
 * over the budget. This typically means the worker was killed mid-job (deploy / OOM / eviction), but it
 * can also happen if a worker ran longer than `staleTimeout`.
 *
 * This is distinct from a worker throwing: the runtime that held the real error is gone, so there is no
 * fresh stack to report. `lastError` (the prior attempt's recorded error, if any) is the best available
 * cause; a `null` `lastError` means the job was orphaned before it ever recorded a failure.
 */
export class JobExhaustedError<
  T extends JobPayload = JobPayload,
  U extends JobResult = JobResult,
> extends Error {
  readonly queue: string;
  readonly jobId: bigint;
  readonly attempts: number;
  readonly maxAttempts: number;
  /** The job's last recorded error from a prior attempt, or `null` if it was orphaned before any error. */
  readonly lastError: unknown;
  /** The job that was retired, for further inspection. */
  readonly job: PrismaJob<T, U>;

  constructor(job: PrismaJob<T, U>, maxAttempts: number) {
    const lastError = job.record.error ?? null;
    super(
      `Job ${job.id} on queue "${job.queue}" exceeded maxAttempts (${maxAttempts}) without completing — ` +
        `it was reclaimed after a prior claim never finished (e.g. the worker was killed mid-job via ` +
        `deploy/OOM/eviction, or ran longer than staleTimeout). ` +
        `Last recorded error: ${lastError ? JSON.stringify(lastError) : "none"}`,
    );
    this.name = "JobExhaustedError";
    this.queue = job.queue;
    this.jobId = job.id;
    this.attempts = job.record.attempts;
    this.maxAttempts = maxAttempts;
    this.lastError = lastError;
    this.job = job;
  }
}
