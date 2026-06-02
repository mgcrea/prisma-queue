import { EventEmitter } from "events";
import assert from "node:assert";

/* eslint-disable @typescript-eslint/no-unnecessary-condition */
import { Cron } from "croner";

import { JobExhaustedError } from "./errors";
import { PrismaJob } from "./PrismaJob";
import type {
  DatabaseJob,
  IntervalDuration,
  JobCreator,
  JobPayload,
  JobResult,
  JobWorker,
  JobWorkerWithClient,
  RepeatFrom,
  RetryStrategy,
  TransactionClient,
} from "./types";
import {
  AbortError,
  calculateDelay,
  debug,
  escape,
  intervalToMs,
  MAX_TIMEOUT_DELAY,
  serializeError,
  waitFor,
} from "./utils";

export type PrismaQueueOptions<C = unknown> = {
  prisma: C;
  name?: string;
  /**
   * Maximum number of attempts before a job is permanently dead-lettered. Defaults to 5. Set to
   * `null` for unlimited retries (relying on a custom `retryStrategy` to stop).
   */
  maxAttempts?: number | null;
  maxConcurrency?: number;
  pollInterval?: number;
  jobInterval?: number;
  tableName?: string;
  /**
   * When to delete a job row after it completes. `"success"` deletes successful jobs (dead-letters
   * retained); `"always"` deletes successes *and* dead-letters — an explicit opt-out of DLQ
   * retention; `"never"` (default) keeps everything. Under `"never"`/`"success"` the dead-letter
   * queue stays inspectable; use `purge()` to prune dead-letters deliberately.
   */
  deleteOn?: "success" | "always" | "never";
  /** Transaction timeout in milliseconds for job processing. Defaults to 30 minutes. */
  transactionTimeout?: number;
  /**
   * In transactional mode, emit a warning if a worker holds its dequeue transaction longer than
   * this many ms — a sign the worker is long-running or uses a separate connection
   * (worker_threads, external services) and should likely use `transactional: false`. Defaults to
   * 50% of `transactionTimeout`. Set to `0`/`null` to disable.
   */
  transactionWarningTimeout?: number | null;
  /** Custom retry strategy. Returns delay in ms, or null to stop retrying. */
  retryStrategy?: RetryStrategy;
  /** Ceiling (ms) for the default retry strategy's backoff delay. Defaults to the `setTimeout` max. */
  maxRetryDelay?: number;
  /**
   * Whether to run the worker inside the dequeue transaction. Defaults to false (at-least-once).
   * Set `true` to run the worker inside the dequeue transaction (exactly-once) — note this holds a
   * row lock and the transaction open for the entire worker duration, so it is unsuitable for
   * long-running workers or workers using a separate connection (worker_threads, external services).
   */
  transactional?: boolean;
  /**
   * Lease duration (ms) after which a claimed-but-unfinished job is automatically reclaimed by the
   * poll loop (non-transactional mode only). Defaults to 6 hours — set this above your longest
   * expected job duration to avoid reclaiming a job mid-flight. Set to `0` or `null` to disable.
   */
  staleTimeout?: number | null;
  /**
   * Per-job wall-clock timeout (ms) for non-transactional mode. When exceeded, the job's `signal` is
   * aborted (cooperative cancellation) and the attempt fails with a timeout error (retried or
   * dead-lettered as usual). Defaults to `null` (disabled). In transactional mode use
   * `transactionTimeout` instead. Note: a non-cooperative worker keeps running in the background; the
   * signal is the only way to actually stop it.
   */
  jobTimeout?: number | null;
};

export type EnqueueOptions = {
  cron?: string;
  intervalMs?: number;
  repeatFrom?: RepeatFrom;
  runAt?: Date;
  key?: string;
  maxAttempts?: number;
  priority?: number;
};

type BaseScheduleOptions = Omit<EnqueueOptions, "key" | "cron" | "intervalMs" | "repeatFrom"> & {
  key: string;
};
export type ScheduleOptions =
  | (BaseScheduleOptions & { cron: string; interval?: never; repeatFrom?: never })
  | (BaseScheduleOptions & {
      interval: IntervalDuration;
      cron?: never;
      repeatFrom?: RepeatFrom;
    });

type DequeueOutcome<T extends JobPayload, U extends JobResult> =
  | { job: PrismaJob<T, U> | null; status: "none" }
  | { job: PrismaJob<T, U>; status: "success"; result: U; rescheduled?: DatabaseJob<T, U> }
  | {
      job: PrismaJob<T, U>;
      status: "error";
      error: unknown;
      /** True when this failure was terminal (no more retries) and the job was dead-lettered. */
      deadLettered?: boolean;
      rescheduled?: DatabaseJob<T, U>;
    };

export type PrismaQueueEvents<T extends JobPayload = JobPayload, U extends JobResult = JobResult> = {
  enqueue: (job: PrismaJob<T, U>) => void;
  dequeue: (job: PrismaJob<T, U>) => void;
  success: (result: U, job: PrismaJob<T, U>) => void;
  jobError: (error: unknown, job: PrismaJob<T, U>) => void;
  /** Emitted once when a job is permanently dead-lettered after exhausting its attempts. */
  dead: (error: unknown, job: PrismaJob<T, U>) => void;
  /**
   * Emitted when the stale lease (or a manual `requeueStale`) reclaims jobs that were claimed but never
   * finished — the root-cause event behind a later `JobExhaustedError`. Reports each reclaimed job id and
   * how long it had been stuck, so an orphaned-then-retired job is traceable end to end.
   */
  reclaim: (jobs: { id: bigint; stuckForMs: number }[]) => void;
  error: (error: unknown) => void;
};

export interface PrismaQueue<
  T extends JobPayload = JobPayload,
  U extends JobResult = JobResult,
  // oxlint-disable-next-line no-unused-vars
  C = unknown,
> {
  on<E extends keyof PrismaQueueEvents<T, U>>(event: E, listener: PrismaQueueEvents<T, U>[E]): this;
  once<E extends keyof PrismaQueueEvents<T, U>>(event: E, listener: PrismaQueueEvents<T, U>[E]): this;
  emit<E extends keyof PrismaQueueEvents<T, U>>(
    event: E,
    ...args: Parameters<PrismaQueueEvents<T, U>[E]>
  ): boolean;
}

const DEFAULT_MAX_CONCURRENCY = 1;
const DEFAULT_POLL_INTERVAL = 10 * 1000;
const DEFAULT_JOB_INTERVAL = 50;
const DEFAULT_DELETE_ON = "never";
const DEFAULT_MAX_ATTEMPTS = 5; // finite by default so a poison job dead-letters instead of retrying forever
const DEFAULT_STALE_TIMEOUT = 6 * 60 * 60 * 1000; // 6 hours — generous so long-running jobs aren't reclaimed mid-flight
const makeDefaultRetryStrategy =
  (maxDelay: number): RetryStrategy =>
  ({ attempts, maxAttempts }) => {
    if (maxAttempts !== null && attempts >= maxAttempts) return null;
    return calculateDelay(attempts, maxDelay);
  };

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class PrismaQueue<
  T extends JobPayload = JobPayload,
  U extends JobResult = JobResult,
  C = unknown,
> extends EventEmitter {
  #prisma: C;
  #escapedTableName: string;
  #delegateKey: "queueJob";
  private name: string;
  private config: Required<Omit<PrismaQueueOptions<C>, "name" | "prisma">>;

  private concurrency = 0;
  private stopped = true;
  private abortController = new AbortController();
  /** Timestamp (ms) of the last stale-job reclamation sweep; throttles the lease in `poll()`. */
  #lastReclaimAt = 0;
  /** Resolvers awaiting `concurrency` reaching 0, used by `stop()` to drain without busy-waiting. */
  #drainResolvers: Array<() => void> = [];
  /** Resolvers for the current idle poll wait, woken early by `enqueue()` for low-latency pickup. */
  #wakeResolvers: Array<() => void> = [];
  /** Set when `#wake()` fires with no active idle waiter, so the next idle wait returns immediately. */
  #pendingWake = false;

  /**
   * Constructs a PrismaQueue object with specified options and a worker function.
   * Use the `createQueue` factory function for type-safe overloads based on the `transactional` option.
   * @param options - Configuration options for the queue.
   * @param worker - The worker function that processes jobs.
   */
  public constructor(
    private options: PrismaQueueOptions<C>,
    public worker: JobWorker<T, U, C> | JobWorkerWithClient<T, U, C>,
  ) {
    super();

    const {
      prisma,
      name = "default",
      tableName = "queue_jobs",
      maxAttempts = DEFAULT_MAX_ATTEMPTS,
      maxConcurrency = DEFAULT_MAX_CONCURRENCY,
      pollInterval = DEFAULT_POLL_INTERVAL,
      jobInterval = DEFAULT_JOB_INTERVAL,
      deleteOn = DEFAULT_DELETE_ON,
      transactionTimeout = 30 * 60 * 1000,
      transactionWarningTimeout = Math.floor(transactionTimeout / 2),
      maxRetryDelay = MAX_TIMEOUT_DELAY,
      retryStrategy = makeDefaultRetryStrategy(maxRetryDelay),
      transactional = false,
      staleTimeout = DEFAULT_STALE_TIMEOUT,
      jobTimeout = null,
    } = this.options;

    assert(prisma && typeof prisma === "object", "prisma option is required");
    assert(name.length <= 255, "name must be less or equal to 255 chars");
    assert(pollInterval >= 100, "pollInterval must be more than 100 ms");
    assert(jobInterval >= 10, "jobInterval must be more than 10 ms");

    const delegateKey = "queueJob" as const;
    assert(delegateKey in (prisma as object), `Prisma client does not have a "queueJob" delegate`);

    this.name = name;
    this.#prisma = prisma;
    this.#escapedTableName = escape(tableName);
    this.#delegateKey = delegateKey;
    this.config = {
      tableName,
      maxAttempts,
      maxConcurrency,
      pollInterval,
      jobInterval,
      deleteOn,
      transactionTimeout,
      transactionWarningTimeout,
      maxRetryDelay,
      retryStrategy,
      transactional,
      staleTimeout,
      jobTimeout,
    };

    // Default error handlers — loud by default so failures are visible without DEBUG.
    // Registering an "error" listener also prevents EventEmitter from throwing-and-crashing on
    // an otherwise-unhandled "error" event. Users wanting custom routing simply attach their own
    // "error"/"jobError" listeners, which run alongside these defaults.
    this.on("error", (error) => {
      debug(`Queue named="${this.name}" encountered an unexpected error`, error);
      console.error(`[prisma-queue] queue named="${this.name}" encountered an unexpected error`, error);
    });
    this.on("jobError", (error, job) => {
      debug(`Job with id=${job.id} failed for queue named="${this.name}" with error`, error);
      console.error(`[prisma-queue] job id=${job.id} failed for queue named="${this.name}"`, error);
    });
  }

  /**
   * Gets the Prisma delegate associated with the queue job model.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private get model(): any {
    return (this.#prisma as any)[this.#delegateKey];
  }

  /**
   * Gets the Prisma delegate from a transaction-scoped client.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getModel(client: unknown): any {
    return (client as any)[this.#delegateKey];
  }

  /**
   * Starts the job processing in the queue.
   */
  public async start(): Promise<void> {
    debug(`starting queue named="${this.name}"...`);
    if (!this.stopped) {
      debug(`queue named="${this.name}" is already running, skipping...`);
      return;
    }
    this.stopped = false;
    // Reset abort controller for new start
    this.abortController = new AbortController();
    return this.poll();
  }

  /**
   * Stops the job processing in the queue.
   * Waits for all in-flight jobs to complete before returning.
   * @param options - Stop options
   * @param options.timeout - Maximum time in milliseconds to wait for in-flight jobs (default: 30000)
   */
  public async stop(options: { timeout?: number } = {}): Promise<void> {
    const { timeout = 30000 } = options;
    debug(`stopping queue named="${this.name}"...`);
    this.stopped = true;
    this.abortController.abort();

    // Wait for all in-flight jobs to complete — resolves the instant concurrency hits 0 (see the
    // dequeue `.finally` in `poll()`), bounded by `timeout`. No busy-wait.
    if (this.concurrency > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const drained = new Promise<void>((resolve) => {
        this.#drainResolvers.push(resolve);
      });
      const timedOut = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeout);
      });
      await Promise.race([drained, timedOut]);
      if (timer) {
        clearTimeout(timer);
      }
      if (this.concurrency > 0) {
        debug(
          `stop() timed out after ${timeout}ms waiting for ${this.concurrency} in-flight jobs to complete for queue named="${this.name}"`,
        );
      }
    }

    debug(`queue named="${this.name}" stopped with ${this.concurrency} remaining jobs`);
  }

  /**
   * Adds a job to the queue.
   * @param payloadOrFunction - The job payload or a function that returns a job payload.
   * @param options - Options for the job, such as scheduling and attempts.
   */
  public add = (
    payloadOrFunction: T | JobCreator<T, C>,
    options: EnqueueOptions = {},
  ): Promise<PrismaJob<T, U>> => this.enqueue(payloadOrFunction, options);

  /**
   * Adds a job to the queue.
   * @param payloadOrFunction - The job payload or a function that returns a job payload.
   * @param options - Options for the job, such as scheduling and attempts.
   */
  public async enqueue(
    payloadOrFunction: T | JobCreator<T, C>,
    options: EnqueueOptions = {},
  ): Promise<PrismaJob<T, U>> {
    debug(`enqueue`, this.name, payloadOrFunction, options);
    const record = await (this.#prisma as any).$transaction((client: TransactionClient<C>) =>
      this.#enqueueWithClient(client, payloadOrFunction, options),
    );
    const job = new PrismaJob(record as DatabaseJob<T, U>, {
      model: this.model,
      client: this.#prisma,
      tableName: this.#escapedTableName,
    });
    this.emit("enqueue", job);
    // Wake a sleeping poll loop so an immediately-runnable job isn't delayed by the idle interval.
    this.#wake();
    return job;
  }

  /**
   * Bulk-inserts many jobs in a single `createMany` for high-throughput producers — far cheaper than
   * one `enqueue` (and one transaction) per job. Intended for plain, non-recurring jobs: keyed/cron/
   * interval scheduling and per-job payload functions are not supported here (use `enqueue`). Does
   * not emit per-job `enqueue` events. Returns the number of jobs inserted.
   * @param payloads - The job payloads to insert.
   * @param options - Shared options applied to every job (maxAttempts, priority, runAt).
   */
  public async enqueueMany(
    payloads: T[],
    options: Pick<EnqueueOptions, "maxAttempts" | "priority" | "runAt"> = {},
  ): Promise<number> {
    if (payloads.length === 0) {
      return 0;
    }
    const { maxAttempts = this.config.maxAttempts, priority = 0, runAt } = options;
    const now = new Date();
    const data = payloads.map((payload) => ({
      queue: this.name,
      payload,
      maxAttempts,
      priority,
      createdAt: now,
      runAt: runAt ?? now,
    }));
    const { count } = await this.model.createMany({ data });
    debug(`enqueued ${count} jobs in bulk to queue named="${this.name}"`);
    // Wake a sleeping poll loop so immediately-runnable jobs aren't delayed by the idle interval.
    this.#wake();
    return count;
  }

  /**
   * Inserts (or upserts, for keyed jobs) a job record using the provided transaction-scoped client.
   * Extracted from `enqueue` so callers already inside a transaction (e.g. the dequeue completion in
   * transactional mode) can reuse the active client instead of opening a nested `$transaction`.
   */
  async #enqueueWithClient(
    client: TransactionClient<C>,
    payloadOrFunction: T | JobCreator<T, C>,
    options: EnqueueOptions,
  ): Promise<DatabaseJob<T, U>> {
    const { name: queueName, config } = this;
    const {
      key = null,
      cron = null,
      intervalMs = null,
      repeatFrom = null,
      maxAttempts = config.maxAttempts,
      priority = 0,
      runAt,
    } = options;
    const now = new Date();
    const model = this.getModel(client);
    const payload =
      payloadOrFunction instanceof Function ? await payloadOrFunction(client) : payloadOrFunction;
    const data = {
      queue: queueName,
      cron,
      intervalMs: intervalMs === null ? null : BigInt(intervalMs),
      repeatFrom,
      payload,
      maxAttempts,
      priority,
      key,
      createdAt: now,
      runAt: runAt ?? now,
    };
    if (key && runAt) {
      const { count } = await model.deleteMany({
        where: {
          queue: queueName,
          key,
          runAt: {
            gte: now,
            not: runAt,
          },
        },
      });
      if (count > 0) {
        debug(`deleted ${count} conflicting upcoming queue jobs`);
      }
      return (await model.upsert({
        where: { queue_key_runAt: { queue: queueName, key, runAt } },
        create: data,
        update: data,
      })) as DatabaseJob<T, U>;
    }
    return (await model.create({ data })) as DatabaseJob<T, U>;
  }

  /**
   * Schedules a job according to a cron expression or a fixed interval.
   * @param options - Scheduling options. Provide either `cron` or `interval` (not both).
   * @param payloadOrFunction - The job payload or a function that returns a job payload.
   */
  public async schedule(
    options: ScheduleOptions,
    payloadOrFunction: T | JobCreator<T, C>,
  ): Promise<PrismaJob<T, U>> {
    debug(`schedule`, this.name, options, payloadOrFunction);
    const { key, runAt: firstRunAt, maxAttempts, priority } = options;
    const base: EnqueueOptions = { key };
    if (maxAttempts !== undefined) base.maxAttempts = maxAttempts;
    if (priority !== undefined) base.priority = priority;
    if ("cron" in options && options.cron) {
      assert(!("interval" in options && options.interval), "Provide either cron or interval, not both");
      const runAt = firstRunAt ?? new Cron(options.cron).nextRun();
      assert(runAt, `Failed to find a future occurence for given cron`);
      return this.enqueue(payloadOrFunction, { ...base, cron: options.cron, runAt });
    }
    assert("interval" in options && options.interval, "Provide either cron or interval");
    const intervalMs = intervalToMs(options.interval);
    const repeatFrom: RepeatFrom = options.repeatFrom ?? "finishedAt";
    const runAt = firstRunAt ?? new Date();
    return this.enqueue(payloadOrFunction, { ...base, intervalMs, repeatFrom, runAt });
  }

  /**
   * Polls the queue and processes jobs according to the configured intervals and concurrency settings.
   */
  private async poll(): Promise<void> {
    const { maxConcurrency, pollInterval, jobInterval } = this.config;
    debug(
      `polling queue named="${this.name}" with pollInterval=${pollInterval} maxConcurrency=${maxConcurrency}...`,
    );

    // Tracks whether the previous batch of probes produced a job, to pick the backoff below.
    let recentlyActive = false;

    while (!this.stopped) {
      try {
        // #2 Reclaim stale claimed-but-unfinished jobs on a lease (non-transactional mode only).
        await this.#maybeReclaimStale();

        // Saturated: re-check soon (no DB query here) so the next slot is picked up promptly rather
        // than after a full pollInterval.
        if (this.concurrency >= maxConcurrency) {
          await waitFor(jobInterval, this.abortController.signal);
          continue;
        }

        // #7 Probe opportunistically — no pre-COUNT. The dequeue UPDATE already returns nothing on
        // an empty queue, so we just spawn up to the available slots and let each no-op when empty.
        const slotsAvailable = maxConcurrency - this.concurrency;
        recentlyActive = false;
        for (let i = 0; i < slotsAvailable && !this.stopped; i++) {
          debug(`processing job from queue named="${this.name}"...`);
          this.concurrency++;
          setImmediate(() => {
            this.dequeue()
              .then((job) => {
                if (job) {
                  recentlyActive = true;
                  debug(`dequeued job({id: ${job.id}, payload: ${JSON.stringify(job.payload)}})`);
                }
              })
              .catch((error: unknown) => {
                this.emit("error", error);
              })
              .finally(() => {
                this.concurrency--;
                if (this.concurrency === 0) {
                  this.#signalDrained();
                }
              });
          });
          await waitFor(jobInterval, this.abortController.signal);
        }

        // Let the just-spawned probes settle, then back off: short while actively draining the
        // queue, long (pollInterval) when it looks idle (no job found and nothing in flight). The
        // idle wait is interrupted by `#wake()` so a job enqueued mid-sleep is picked up promptly.
        await waitFor(jobInterval * 2, this.abortController.signal);
        if (!recentlyActive && this.concurrency === 0) {
          await this.#waitForPoll(pollInterval);
        }
      } catch (error) {
        if (error instanceof AbortError) {
          debug(`polling for queue named="${this.name}" was aborted`);
          return;
        }
        // Emit error and continue polling after a delay
        this.emit("error", error);
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        await waitFor(pollInterval, this.abortController.signal).catch(() => {});
      }
    }
  }

  /**
   * Resolves any promises registered by `stop()` waiting for the queue to drain. Called from the
   * dequeue `.finally` when `concurrency` reaches 0.
   */
  #signalDrained(): void {
    const resolvers = this.#drainResolvers;
    this.#drainResolvers = [];
    for (const resolve of resolvers) {
      resolve();
    }
  }

  /**
   * Wakes a poll loop currently sleeping out its idle interval so a newly enqueued job is picked up
   * promptly instead of after a full `pollInterval`. If no idle wait is active, the wake is latched
   * and consumed by the next idle wait (so an enqueue that races the loop isn't lost).
   */
  #wake(): void {
    if (this.#wakeResolvers.length > 0) {
      const resolvers = this.#wakeResolvers;
      this.#wakeResolvers = [];
      for (const resolve of resolvers) {
        resolve();
      }
    } else {
      this.#pendingWake = true;
    }
  }

  /**
   * Idle wait used by `poll()`: resolves after `ms`, early on `#wake()`, or rejects with `AbortError`
   * when the queue is stopped. Consumes a latched wake immediately.
   */
  async #waitForPoll(ms: number): Promise<void> {
    const signal = this.abortController.signal;
    if (signal.aborted) {
      throw new AbortError("Aborted");
    }
    if (this.#pendingWake) {
      this.#pendingWake = false;
      return;
    }
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        const index = this.#wakeResolvers.indexOf(onWake);
        if (index >= 0) {
          this.#wakeResolvers.splice(index, 1);
        }
      };
      const onAbort = () => {
        cleanup();
        reject(new AbortError("Aborted"));
      };
      const onWake = () => {
        cleanup();
        resolve();
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, ms);
      this.#wakeResolvers.push(onWake);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * Reclaims jobs that were claimed but never finished (e.g. a non-transactional worker that
   * hard-crashed the runtime) once they exceed the `staleTimeout` lease. Throttled to run at most
   * once per lease window. No-op in transactional mode, where a crash rolls back the claim, and
   * when `staleTimeout` is `0`/`null`.
   */
  async #maybeReclaimStale(): Promise<void> {
    const { staleTimeout, transactional } = this.config;
    if (transactional || !staleTimeout || staleTimeout <= 0) {
      return;
    }
    const now = Date.now();
    if (now - this.#lastReclaimAt < staleTimeout) {
      return;
    }
    this.#lastReclaimAt = now;
    // requeueStale logs and emits the `reclaim` event for any jobs it reclaims.
    await this.requeueStale({ olderThanMs: staleTimeout });
  }

  /**
   * Creates an AbortController for a single job, linked to the queue-wide controller so the job's
   * `signal` aborts both on `stop()` and on a per-job timeout. Returns the controller and a cleanup
   * to detach the link once the job settles.
   */
  #createJobAbort(): { controller: AbortController; cleanup: () => void } {
    const controller = new AbortController();
    const queueSignal = this.abortController.signal;
    if (queueSignal.aborted) {
      controller.abort();
      return { controller, cleanup: () => {} };
    }
    const onQueueAbort = () => controller.abort();
    queueSignal.addEventListener("abort", onQueueAbort, { once: true });
    return { controller, cleanup: () => queueSignal.removeEventListener("abort", onQueueAbort) };
  }

  /**
   * Runs `run()` with the per-job `jobTimeout` (non-transactional mode). On timeout, aborts the job's
   * `controller` (so a cooperative worker watching `job.signal` can stop) and rejects with a timeout
   * error so the attempt is retried/dead-lettered. With no timeout configured, runs `run()` directly.
   */
  async #runWithJobTimeout(run: () => Promise<U>, controller: AbortController, jobId: bigint): Promise<U> {
    const { jobTimeout } = this.config;
    if (!jobTimeout || jobTimeout <= 0) {
      return run();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`Job ${jobId} exceeded jobTimeout (${jobTimeout}ms)`));
      }, jobTimeout);
    });
    try {
      return await Promise.race([run(), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * In transactional mode, schedules a one-shot warning if the worker holds its dequeue transaction
   * longer than `transactionWarningTimeout`. A long hold (often a worker using a separate connection
   * — worker_threads, external services — or simply a long-running job) risks hitting
   * `transactionTimeout` and rolling back the claim, causing the job to be re-dequeued and re-run.
   * Such workers should use `transactional: false`. Returns the timer handle to clear, or `undefined`
   * when the warning is disabled (`0`/`null`).
   */
  #startSlowTransactionWarning(jobId: DatabaseJob<T, U>["id"]): ReturnType<typeof setTimeout> | undefined {
    const { transactionWarningTimeout, transactionTimeout } = this.config;
    if (!transactionWarningTimeout || transactionWarningTimeout <= 0) {
      return undefined;
    }
    return setTimeout(() => {
      console.warn(
        `[prisma-queue] transactional worker for job id=${jobId} on queue named="${this.name}" has held its dequeue transaction for ${transactionWarningTimeout}ms (transactionTimeout=${transactionTimeout}ms). Long-running workers, or workers that use a separate connection (worker_threads, external services), should use { transactional: false }.`,
      );
    }, transactionWarningTimeout);
  }

  /**
   * Dequeues and processes the next job in the queue. Dispatches to transactional or
   * non-transactional path based on configuration, then emits events and handles cron scheduling.
   * @returns {Promise<PrismaJob<T, U> | null>} The job that was processed or null if no job was available.
   */
  private async dequeue(): Promise<PrismaJob<T, U> | null> {
    if (this.stopped) {
      return null;
    }
    debug(`dequeuing from queue named="${this.name}"...`);

    const outcome = this.config.transactional
      ? await this.dequeueTransactional()
      : await this.dequeueNonTransactional();
    const { job } = outcome;

    if (job) {
      // Emit events in logical order: dequeue first, then success/error
      this.emit("dequeue", job);
      if (outcome.status === "success") {
        this.emit("success", outcome.result, job);
      } else if (outcome.status === "error") {
        this.emit("jobError", outcome.error, job);
        // Distinct signal for permanent failures, so dead-letters can be alerted on separately.
        if (outcome.deadLettered) {
          this.emit("dead", outcome.error, job);
        }
      }

      // In transactional mode the next occurrence was already enqueued atomically inside the
      // dequeue transaction; surface it as an "enqueue" event now that it has committed. In
      // non-transactional mode we (best-effort) enqueue it here; failures surface through the loud
      // "error" event rather than being silently swallowed.
      if (this.config.transactional) {
        if (outcome.status !== "none" && outcome.rescheduled) {
          const nextJob = new PrismaJob(outcome.rescheduled, {
            model: this.model,
            client: this.#prisma,
            tableName: this.#escapedTableName,
          });
          this.emit("enqueue", nextJob);
        }
      } else {
        const next = this.#nextOccurrenceOptions(job);
        if (next) {
          try {
            debug(
              `scheduling next occurrence for job({key: ${job.key}}) with payload=${JSON.stringify(next.payload)}`,
            );
            await this.enqueue(next.payload, next.options);
          } catch (scheduleError) {
            this.emit("error", scheduleError);
          }
        }
      }
    }

    return job;
  }

  /**
   * Computes the enqueue arguments for the next occurrence of a finished recurring job, or `null`
   * when the job is not recurring (no `key`, or neither `cron` nor `intervalMs` set). Shared by the
   * transactional (in-transaction) and non-transactional (post-commit) reschedule paths.
   */
  #nextOccurrenceOptions(job: PrismaJob<T, U>): { payload: T; options: EnqueueOptions } | null {
    const { key, cron, intervalMs, repeatFrom, payload, finishedAt } = job;
    if (!finishedAt || !key) {
      return null;
    }
    if (cron) {
      const runAt = new Cron(cron).nextRun();
      if (!runAt) {
        return null;
      }
      return { payload: payload as T, options: { key, cron, runAt } };
    }
    if (intervalMs !== null) {
      const intervalMsNumber = Number(intervalMs);
      const base = repeatFrom === "runAt" ? job.runAt.getTime() : finishedAt.getTime();
      const nextRunAt = new Date(base + intervalMsNumber);
      return {
        payload: payload as T,
        options: {
          key,
          intervalMs: intervalMsNumber,
          repeatFrom: (repeatFrom ?? "finishedAt") as RepeatFrom,
          runAt: nextRunAt,
        },
      };
    }
    return null;
  }

  /**
   * Marks a job terminally failed because it was claimed past its `maxAttempts` without ever
   * completing (e.g. a worker that hard-crashed the runtime, was reclaimed by the lease, and
   * exhausted its budget). Returns the error recorded against the job.
   */
  async #finalizeExhausted(job: PrismaJob<T, U>, maxAttempts: number): Promise<Error> {
    // A dedicated error type carrying queue/job/attempts and the prior attempt's recorded error, so the
    // failure is self-explanatory (the generic message alone hides which queue and why it never completed).
    const error = new JobExhaustedError(job, maxAttempts);
    const date = new Date();
    await job.update({
      finishedAt: date,
      failedAt: date,
      deadLetteredAt: date,
      error: serializeError(error),
      notBefore: null,
    });
    // Dead-letters are retained by default so the DLQ stays inspectable; only `deleteOn: "always"`
    // (an explicit opt-out) removes them. Use `purge({ deadLetteredOnly: true })` to prune otherwise.
    if (this.config.deleteOn === "always") {
      await job.delete();
    }
    return error;
  }

  private async dequeueTransactional(): Promise<DequeueOutcome<T, U>> {
    const { name: queueName } = this;
    const { deleteOn, transactionTimeout } = this.config;
    const tableName = this.#escapedTableName;
    const now = new Date();
    const worker = this.worker as JobWorker<T, U, C>;

    return (await (this.#prisma as any).$transaction(
      async (client: TransactionClient<C>): Promise<DequeueOutcome<T, U>> => {
        const rows: DatabaseJob<T, U>[] = await (client as any).$queryRawUnsafe(
          `UPDATE ${tableName} SET "processedAt" = $2, "attempts" = "attempts" + 1
           WHERE id = (
             SELECT id
             FROM ${tableName}
             WHERE (${tableName}."queue" = $1)
               AND (${tableName}."finishedAt" IS NULL)
               AND (${tableName}."processedAt" IS NULL)
               AND (${tableName}."runAt" <= $2)
               AND (${tableName}."notBefore" IS NULL OR ${tableName}."notBefore" <= $2)
             ORDER BY ${tableName}."priority" ASC, ${tableName}."runAt" ASC
             FOR UPDATE SKIP LOCKED
             LIMIT 1
           )
           RETURNING *;`,
          queueName,
          now,
        );
        if (!rows.length || !rows[0]) {
          debug(`no jobs found in queue named="${this.name}"`);
          return { job: null, status: "none" };
        }
        const { id, payload, attempts, maxAttempts } = rows[0];
        const job = new PrismaJob<T, U>(rows[0], {
          model: this.getModel(client),
          client,
          tableName,
          signal: this.abortController.signal,
        });
        let outcome: DequeueOutcome<T, U>;
        // #1 Claim-time enforcement: a job claimed past its budget (already incremented above) is
        // failed terminally without running. This defends non-transactional mode, where a hard-
        // crashing worker's attempts++ commits and the lease keeps reclaiming it until exhausted.
        // In transactional mode a hard crash rolls back the attempts++, so this branch is
        // effectively a no-op there — by design, not a bug.
        if (maxAttempts !== null && attempts > maxAttempts) {
          const error = await this.#finalizeExhausted(job, maxAttempts);
          outcome = { job, status: "error", error, deadLettered: true };
        } else {
          const warnTimer = this.#startSlowTransactionWarning(id);
          try {
            debug(`starting worker for job({id: ${id}, payload: ${JSON.stringify(payload)}})`);
            const result = await worker(job, client);
            clearTimeout(warnTimer);
            debug(`finished worker for job({id: ${id}, payload: ${JSON.stringify(payload)}})`);
            const date = new Date();
            await job.update({ finishedAt: date, progress: 100, result, error: null });
            if (deleteOn === "success" || deleteOn === "always") {
              await job.delete();
            }
            outcome = { job, status: "success", result };
          } catch (error) {
            clearTimeout(warnTimer);
            const date = new Date();
            debug(
              `failed finishing job({id: ${id}, payload: ${JSON.stringify(payload)}}) with error="${String(error)}"`,
            );
            const delay = this.config.retryStrategy({ attempts, maxAttempts, error });
            const isFinished = delay === null;
            if (!isFinished) {
              const notBefore = new Date(date.getTime() + delay);
              debug(`will retry at notBefore=${notBefore.toISOString()} (attempts=${attempts})`);
              await job.update({
                processedAt: null,
                finishedAt: null,
                failedAt: date,
                error: serializeError(error),
                notBefore,
              });
            } else {
              await job.update({
                finishedAt: date,
                failedAt: date,
                deadLetteredAt: date,
                error: serializeError(error),
                notBefore: null,
              });
            }
            // Terminal failures become dead-letters: retained for inspection unless deleteOn:"always".
            if (isFinished && deleteOn === "always") {
              await job.delete();
            }
            outcome = { job, status: "error", error, deadLettered: isFinished };
          }
        }
        // #3 Enqueue the next occurrence inside the same transaction so completion and the next
        // scheduled run commit atomically. A failure here rolls back the whole job (which is then
        // retried) rather than silently breaking the recurring chain. The record is surfaced as an
        // "enqueue" event by the caller once the transaction commits.
        const next = this.#nextOccurrenceOptions(job);
        if (next) {
          debug(`scheduling next occurrence for job({key: ${job.key}}) inside dequeue transaction`);
          const rescheduled = await this.#enqueueWithClient(client, next.payload, next.options);
          return { ...outcome, rescheduled };
        }
        return outcome;
      },
      // @NOTE https://github.com/prisma/prisma/issues/11565#issuecomment-1031380271
      { timeout: transactionTimeout },
    )) as DequeueOutcome<T, U>;
  }

  private async dequeueNonTransactional(): Promise<DequeueOutcome<T, U>> {
    const { name: queueName } = this;
    const { deleteOn } = this.config;
    const tableName = this.#escapedTableName;
    const now = new Date();
    const worker = this.worker as JobWorkerWithClient<T, U, C>;

    // Phase 1: Claim the job atomically (single-statement implicit transaction)
    const rows: DatabaseJob<T, U>[] = await (this.#prisma as any).$queryRawUnsafe(
      `UPDATE ${tableName} SET "processedAt" = $2, "attempts" = "attempts" + 1
       WHERE id = (
         SELECT id
         FROM ${tableName}
         WHERE (${tableName}."queue" = $1)
           AND (${tableName}."finishedAt" IS NULL)
           AND (${tableName}."processedAt" IS NULL)
           AND (${tableName}."runAt" <= $2)
           AND (${tableName}."notBefore" IS NULL OR ${tableName}."notBefore" <= $2)
         ORDER BY ${tableName}."priority" ASC, ${tableName}."runAt" ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING *;`,
      queueName,
      now,
    );

    if (!rows.length || !rows[0]) {
      debug(`no jobs found in queue named="${this.name}"`);
      return { job: null, status: "none" };
    }

    const { id, payload, attempts, maxAttempts } = rows[0];
    // Per-job abort signal: aborts on stop() or on the per-job timeout below.
    const { controller, cleanup } = this.#createJobAbort();
    const job = new PrismaJob<T, U>(rows[0], {
      model: this.model,
      client: this.#prisma,
      tableName,
      signal: controller.signal,
    });

    // #1 Claim-time enforcement: a job reclaimed by the lease past its budget (e.g. a worker that
    // hard-crashed the runtime, so the catch below never ran) is failed terminally without running.
    if (maxAttempts !== null && attempts > maxAttempts) {
      cleanup();
      const error = await this.#finalizeExhausted(job, maxAttempts);
      return { job, status: "error", error, deadLettered: true };
    }

    // Phase 2: Run worker outside any transaction, bounded by the optional jobTimeout.
    try {
      debug(`starting worker for job({id: ${id}, payload: ${JSON.stringify(payload)}})`);
      const result = await this.#runWithJobTimeout(() => worker(job, this.#prisma), controller, id);
      debug(`finished worker for job({id: ${id}, payload: ${JSON.stringify(payload)}})`);

      // Phase 3a: Update success
      const date = new Date();
      await job.update({ finishedAt: date, progress: 100, result, error: null });
      if (deleteOn === "success" || deleteOn === "always") {
        await job.delete();
      }
      return { job, status: "success", result };
    } catch (error) {
      // Phase 3b: Update error/retry
      const date = new Date();
      debug(
        `failed finishing job({id: ${id}, payload: ${JSON.stringify(payload)}}) with error="${String(error)}"`,
      );
      const delay = this.config.retryStrategy({ attempts, maxAttempts, error });
      const isFinished = delay === null;
      if (!isFinished) {
        const notBefore = new Date(date.getTime() + delay);
        debug(`will retry at notBefore=${notBefore.toISOString()} (attempts=${attempts})`);
        await job.update({
          processedAt: null,
          finishedAt: null,
          failedAt: date,
          error: serializeError(error),
          notBefore,
        });
      } else {
        await job.update({
          finishedAt: date,
          failedAt: date,
          deadLetteredAt: date,
          error: serializeError(error),
          notBefore: null,
        });
      }
      // Terminal failures become dead-letters: retained for inspection unless deleteOn:"always".
      if (isFinished && deleteOn === "always") {
        await job.delete();
      }
      return { job, status: "error", error, deadLettered: isFinished };
    } finally {
      cleanup();
    }
  }

  /**
   * Requeues stale jobs that were claimed but never completed (e.g., due to a process crash
   * in non-transactional mode). Resets `processedAt` to null for jobs older than the cutoff, and
   * emits a `reclaim` event reporting each reclaimed job's id and how long it had been stuck.
   * @param options.olderThanMs - Only requeue jobs claimed more than this many milliseconds ago.
   * @returns The number of jobs requeued.
   */
  public async requeueStale(options: { olderThanMs: number }): Promise<number> {
    const cutoff = new Date(Date.now() - options.olderThanMs);
    const tableName = this.#escapedTableName;
    // Single atomic statement: lock the stale rows, reset their claim, and RETURN exactly the rows
    // reset together with their pre-reset claim time. This keeps the `reclaim` event accurate (no
    // snapshot/update race), avoids round-tripping a potentially huge id list after a mass crash, and
    // `SKIP LOCKED` steps around any concurrent dequeue rather than blocking on it.
    const rows: { id: bigint; prevProcessedAt: Date }[] = await (this.#prisma as any).$queryRawUnsafe(
      `WITH stale AS (
         SELECT id, "processedAt"
         FROM ${tableName}
         WHERE ("queue" = $1)
           AND ("processedAt" <= $2)
           AND ("finishedAt" IS NULL)
         FOR UPDATE SKIP LOCKED
       )
       UPDATE ${tableName} AS q
       SET "processedAt" = NULL
       FROM stale
       WHERE q.id = stale.id
       RETURNING q.id AS "id", stale."processedAt" AS "prevProcessedAt";`,
      this.name,
      cutoff,
    );
    if (rows.length === 0) {
      return 0;
    }
    const now = Date.now();
    const reclaimed = rows.map((row) => ({
      id: row.id,
      stuckForMs: Math.max(0, now - new Date(row.prevProcessedAt).getTime()),
    }));
    this.emit("reclaim", reclaimed);
    debug(`reclaimed ${rows.length} stale job(s) for queue named="${this.name}"`);
    return rows.length;
  }

  /**
   * Deletes completed jobs (those with `finishedAt` set) older than the cutoff, for table retention.
   * The dequeue hot path filters `finishedAt IS NULL`, so purging finished rows keeps the working set
   * (and the index) small without affecting pending work.
   * @param options.olderThanMs - Only delete jobs finished more than this many milliseconds ago.
   * @param options.deadLetteredOnly - When true, only delete dead-lettered jobs (keep successes).
   * @returns The number of jobs deleted.
   */
  public async purge(options: { olderThanMs: number; deadLetteredOnly?: boolean }): Promise<number> {
    const { olderThanMs, deadLetteredOnly = false } = options;
    const cutoff = new Date(Date.now() - olderThanMs);
    const where: Record<string, unknown> = {
      queue: this.name,
      finishedAt: { lte: cutoff },
    };
    if (deadLetteredOnly) {
      where["deadLetteredAt"] = { not: null };
    }
    const { count } = await this.model.deleteMany({ where });
    return count;
  }

  /**
   * Returns a breakdown of job counts by state for this queue, useful for monitoring/alerting (e.g.
   * dead-letter depth or a growing backlog). The five states are mutually exclusive and cover every
   * row: `pending` (ready to run now), `scheduled` (waiting on `runAt`/`notBefore`), `processing`
   * (claimed but unfinished, includes stale claims), `completed` (succeeded), `dead` (dead-lettered).
   */
  public async stats(): Promise<{
    pending: number;
    scheduled: number;
    processing: number;
    completed: number;
    dead: number;
  }> {
    const queue = this.name;
    const now = new Date();
    const [pending, scheduled, processing, completed, dead] = await Promise.all([
      this.model.count({
        where: {
          queue,
          finishedAt: null,
          processedAt: null,
          runAt: { lte: now },
          OR: [{ notBefore: null }, { notBefore: { lte: now } }],
        },
      }),
      this.model.count({
        where: {
          queue,
          finishedAt: null,
          processedAt: null,
          OR: [{ runAt: { gt: now } }, { notBefore: { gt: now } }],
        },
      }),
      this.model.count({ where: { queue, finishedAt: null, processedAt: { not: null } } }),
      this.model.count({ where: { queue, finishedAt: { not: null }, deadLetteredAt: null } }),
      this.model.count({ where: { queue, deadLetteredAt: { not: null } } }),
    ]);
    return { pending, scheduled, processing, completed, dead };
  }

  /**
   * Counts the number of jobs in the queue, optionally only those available for processing.
   * Note: When onlyAvailable is true, the count may include jobs currently being processed
   * by other workers. This is by design — the dequeue query uses SKIP LOCKED to handle
   * concurrent access, so a slightly inflated count only results in benign no-op dequeue attempts.
   * @param {boolean} onlyAvailable - If true, counts only jobs that are ready to be processed.
   * @returns {Promise<number>} The number of jobs.
   */
  public async size(onlyAvailable?: boolean): Promise<number> {
    const { name: queueName } = this;
    const date = new Date();
    const where: Record<string, unknown> = { queue: queueName, finishedAt: null };
    if (onlyAvailable) {
      where["runAt"] = { lte: date };
      where["processedAt"] = null;
      where["AND"] = { OR: [{ notBefore: { lte: date } }, { notBefore: null }] };
    }
    return await this.model.count({
      where,
    });
  }
}
