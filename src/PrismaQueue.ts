/* eslint-disable @typescript-eslint/no-unnecessary-condition */
import { Prisma, PrismaClient } from "@prisma/client";
import { Cron } from "croner";
import { EventEmitter } from "events";
import assert from "node:assert";
import { PrismaJob } from "./PrismaJob";
import type {
  DatabaseJob,
  JobCreator,
  JobPayload,
  JobResult,
  JobWorker,
  JobWorkerWithClient,
  PrismaLightClient,
  RetryStrategy,
} from "./types";
import { AbortError, calculateDelay, debug, escape, getTableName, serializeError, waitFor } from "./utils";

export type PrismaQueueOptions = {
  prisma?: PrismaClient;
  name?: string;
  maxAttempts?: number | null;
  maxConcurrency?: number;
  pollInterval?: number;
  jobInterval?: number;
  tableName?: string;
  deleteOn?: "success" | "failure" | "always" | "never";
  /** Transaction timeout in milliseconds for job processing. Defaults to 30 minutes. */
  transactionTimeout?: number;
  /** Custom retry strategy. Returns delay in ms, or null to stop retrying. */
  retryStrategy?: RetryStrategy;
  /** Whether to run the worker inside the dequeue transaction. Defaults to true. */
  transactional?: boolean;
};

export type EnqueueOptions = {
  cron?: string;
  runAt?: Date;
  key?: string;
  maxAttempts?: number;
  priority?: number;
};

export type ScheduleOptions = Omit<EnqueueOptions, "key" | "cron"> & {
  key: string;
  cron: string;
};

export type PrismaQueueEvents<T extends JobPayload = JobPayload, U extends JobResult = JobResult> = {
  enqueue: (job: PrismaJob<T, U>) => void;
  dequeue: (job: PrismaJob<T, U>) => void;
  success: (result: U, job: PrismaJob<T, U>) => void;
  jobError: (error: unknown, job: PrismaJob<T, U>) => void;
  error: (error: unknown) => void;
};

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export interface PrismaQueue<T extends JobPayload = JobPayload, U extends JobResult = JobResult> {
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
const defaultRetryStrategy: RetryStrategy = ({ attempts, maxAttempts }) => {
  if (maxAttempts !== null && attempts >= maxAttempts) return null;
  return calculateDelay(attempts);
};

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class PrismaQueue<
  T extends JobPayload = JobPayload,
  U extends JobResult = JobResult,
> extends EventEmitter {
  #prisma: PrismaClient;
  #escapedTableName: string;
  #delegateKey: "queueJob";
  private name: string;
  private config: Required<Omit<PrismaQueueOptions, "name" | "prisma">>;

  private concurrency = 0;
  private stopped = true;
  private abortController = new AbortController();

  /**
   * Constructs a PrismaQueue object with specified options and a worker function.
   * Use the `createQueue` factory function for type-safe overloads based on the `transactional` option.
   * @param options - Configuration options for the queue.
   * @param worker - The worker function that processes jobs.
   */
  public constructor(
    private options: PrismaQueueOptions = {},
    public worker: JobWorker<T, U> | JobWorkerWithClient<T, U>,
  ) {
    super();

    const {
      prisma = new PrismaClient(),
      name = "default",
      tableName = getTableName("QueueJob"),
      maxAttempts = null,
      maxConcurrency = DEFAULT_MAX_CONCURRENCY,
      pollInterval = DEFAULT_POLL_INTERVAL,
      jobInterval = DEFAULT_JOB_INTERVAL,
      deleteOn = DEFAULT_DELETE_ON,
      transactionTimeout = 30 * 60 * 1000,
      retryStrategy = defaultRetryStrategy,
      transactional = true,
    } = this.options;

    assert(name.length <= 255, "name must be less or equal to 255 chars");
    assert(pollInterval >= 100, "pollInterval must be more than 100 ms");
    assert(jobInterval >= 10, "jobInterval must be more than 10 ms");

    const delegateKey = "queueJob" as const;
    assert(delegateKey in prisma, `Prisma client does not have a "queueJob" delegate`);

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
      retryStrategy,
      transactional,
    };

    // Default error handlers
    this.on("error", (error) => {
      debug(`Queue named="${this.name}" encountered an unexpected error`, error);
    });
    this.on("jobError", (error, job) => {
      debug(`Job with id=${job.id} failed for queue named="${this.name}" with error`, error);
    });
  }

  /**
   * Gets the Prisma delegate associated with the queue job model.
   */
  private get model(): Prisma.QueueJobDelegate {
    return this.#prisma[this.#delegateKey];
  }

  /**
   * Gets the Prisma delegate from a transaction-scoped client.
   */
  private getModel(client: PrismaLightClient): Prisma.QueueJobDelegate {
    return client[this.#delegateKey];
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

    // Wait for all in-flight jobs to complete
    const checkInterval = 100; // Check every 100ms
    const startTime = Date.now();

    while (this.concurrency > 0) {
      if (Date.now() - startTime > timeout) {
        debug(
          `stop() timed out after ${timeout}ms waiting for ${this.concurrency} in-flight jobs to complete for queue named="${this.name}"`,
        );
        break;
      }
      await waitFor(checkInterval);
    }

    debug(`queue named="${this.name}" stopped with ${this.concurrency} remaining jobs`);
  }

  /**
   * Adds a job to the queue.
   * @param payloadOrFunction - The job payload or a function that returns a job payload.
   * @param options - Options for the job, such as scheduling and attempts.
   */
  public add = (
    payloadOrFunction: T | JobCreator<T>,
    options: EnqueueOptions = {},
  ): Promise<PrismaJob<T, U>> => this.enqueue(payloadOrFunction, options);

  /**
   * Adds a job to the queue.
   * @param payloadOrFunction - The job payload or a function that returns a job payload.
   * @param options - Options for the job, such as scheduling and attempts.
   */
  public async enqueue(
    payloadOrFunction: T | JobCreator<T>,
    options: EnqueueOptions = {},
  ): Promise<PrismaJob<T, U>> {
    debug(`enqueue`, this.name, payloadOrFunction, options);
    const { name: queueName, config } = this;
    const { key = null, cron = null, maxAttempts = config.maxAttempts, priority = 0, runAt } = options;
    const now = new Date();
    const record = await this.#prisma.$transaction(async (client) => {
      const model = this.getModel(client);
      const payload =
        payloadOrFunction instanceof Function ? await payloadOrFunction(client) : payloadOrFunction;
      const data = {
        queue: queueName,
        cron,
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
        return await model.upsert({
          where: { key_runAt: { key, runAt } },
          create: data,
          update: data,
        });
      }
      return await model.create({ data });
    });
    const job = new PrismaJob(record as DatabaseJob<T, U>, {
      model: this.model,
      client: this.#prisma,
      tableName: this.#escapedTableName,
    });
    this.emit("enqueue", job);
    return job;
  }

  /**
   * Schedules a job according to the cron expression or a specific run time.
   * @param options - Scheduling options including cron, key, and run time.
   * @param payloadOrFunction - The job payload or a function that returns a job payload.
   */
  public async schedule(
    options: ScheduleOptions,
    payloadOrFunction: T | JobCreator<T>,
  ): Promise<PrismaJob<T, U>> {
    debug(`schedule`, this.name, options, payloadOrFunction);
    const { key, cron, runAt: firstRunAt, ...otherOptions } = options;
    const runAt = firstRunAt ?? new Cron(cron).nextRun();
    assert(runAt, `Failed to find a future occurence for given cron`);
    return this.enqueue(payloadOrFunction, { key, cron, runAt, ...otherOptions });
  }

  /**
   * Polls the queue and processes jobs according to the configured intervals and concurrency settings.
   */
  private async poll(): Promise<void> {
    const { maxConcurrency, pollInterval, jobInterval } = this.config;
    debug(
      `polling queue named="${this.name}" with pollInterval=${pollInterval} maxConcurrency=${maxConcurrency}...`,
    );

    while (!this.stopped) {
      try {
        // Wait for the queue to be ready
        if (this.concurrency >= maxConcurrency) {
          await waitFor(pollInterval, this.abortController.signal);
          continue;
        }
        // Query the queue size only when needed to reduce database load.
        const queueSize = await this.size(true);
        if (queueSize === 0) {
          await waitFor(pollInterval, this.abortController.signal);
          continue;
        }

        // Process available jobs up to concurrency limit
        const slotsAvailable = maxConcurrency - this.concurrency;
        const jobsToProcess = Math.min(queueSize, slotsAvailable);

        for (let i = 0; i < jobsToProcess && !this.stopped; i++) {
          debug(`processing job from queue named="${this.name}"...`);
          this.concurrency++;
          setImmediate(() => {
            this.dequeue()
              .then((job) => {
                if (job) {
                  debug(`dequeued job({id: ${job.id}, payload: ${JSON.stringify(job.payload)}})`);
                }
              })
              .catch((error: unknown) => {
                this.emit("error", error);
              })
              .finally(() => {
                this.concurrency--;
              });
          });
          await waitFor(jobInterval, this.abortController.signal);
        }

        // Wait before checking queue again
        await waitFor(jobInterval * 2, this.abortController.signal);
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
   * Dequeues and processes the next job in the queue. Dispatches to transactional or
   * non-transactional path based on configuration, then emits events and handles cron scheduling.
   * @returns {Promise<PrismaJob<T, U> | null>} The job that was processed or null if no job was available.
   */
  private async dequeue(): Promise<PrismaJob<T, U> | null> {
    if (this.stopped) {
      return null;
    }
    debug(`dequeuing from queue named="${this.name}"...`);

    const { job, successResult, errorResult } = this.config.transactional
      ? await this.dequeueTransactional()
      : await this.dequeueNonTransactional();

    if (job) {
      // Emit events in logical order: dequeue first, then success/error
      this.emit("dequeue", job);
      if (successResult !== undefined) {
        this.emit("success", successResult, job);
      } else if (errorResult !== undefined) {
        this.emit("jobError", errorResult, job);
      }

      const { key, cron, payload, finishedAt } = job;
      if (finishedAt && cron && key) {
        // Schedule next cron
        debug(
          `scheduling next cron job({key: ${key}, cron: ${cron}}) with payload=${JSON.stringify(payload)}`,
        );
        try {
          await this.schedule({ key, cron }, payload);
        } catch (scheduleError) {
          this.emit("error", scheduleError);
        }
      }
    }

    return job;
  }

  private async dequeueTransactional(): Promise<{
    job: PrismaJob<T, U> | null;
    successResult: U | undefined;
    errorResult: unknown;
  }> {
    const { name: queueName } = this;
    const { deleteOn, transactionTimeout } = this.config;
    const tableName = this.#escapedTableName;
    const now = new Date();
    const worker = this.worker as JobWorker<T, U>;

    let successResult: U | undefined;
    let errorResult: unknown;

    const job = await this.#prisma.$transaction(
      async (client) => {
        const rows = await client.$queryRawUnsafe<DatabaseJob<T, U>[]>(
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
          return null;
        }
        const { id, payload, attempts, maxAttempts } = rows[0];
        const job = new PrismaJob<T, U>(rows[0], {
          model: this.getModel(client),
          client,
          tableName,
          signal: this.abortController.signal,
        });
        let result;
        try {
          debug(`starting worker for job({id: ${id}, payload: ${JSON.stringify(payload)}})`);
          result = await worker(job, client);
          debug(`finished worker for job({id: ${id}, payload: ${JSON.stringify(payload)}})`);
          const date = new Date();
          await job.update({ finishedAt: date, progress: 100, result, error: Prisma.DbNull });
          successResult = result;
          if (deleteOn === "success" || deleteOn === "always") {
            await job.delete();
          }
        } catch (error) {
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
              error: serializeError(error),
              notBefore: null,
            });
          }
          errorResult = error;
          if (deleteOn === "failure" || deleteOn === "always") {
            await job.delete();
          }
        }
        return job;
      },
      // @NOTE https://github.com/prisma/prisma/issues/11565#issuecomment-1031380271
      { timeout: transactionTimeout },
    );

    return { job, successResult, errorResult };
  }

  private async dequeueNonTransactional(): Promise<{
    job: PrismaJob<T, U> | null;
    successResult: U | undefined;
    errorResult: unknown;
  }> {
    const { name: queueName } = this;
    const { deleteOn } = this.config;
    const tableName = this.#escapedTableName;
    const now = new Date();
    const worker = this.worker as JobWorkerWithClient<T, U>;

    let successResult: U | undefined;
    let errorResult: unknown;

    // Phase 1: Claim the job atomically (single-statement implicit transaction)
    const rows = await this.#prisma.$queryRawUnsafe<DatabaseJob<T, U>[]>(
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
      return { job: null, successResult: undefined, errorResult: undefined };
    }

    const { id, payload, attempts, maxAttempts } = rows[0];
    const job = new PrismaJob<T, U>(rows[0], {
      model: this.model,
      client: this.#prisma,
      tableName,
      signal: this.abortController.signal,
    });

    // Phase 2: Run worker outside any transaction
    try {
      debug(`starting worker for job({id: ${id}, payload: ${JSON.stringify(payload)}})`);
      const result = await worker(job, this.#prisma);
      debug(`finished worker for job({id: ${id}, payload: ${JSON.stringify(payload)}})`);

      // Phase 3a: Update success
      const date = new Date();
      await job.update({ finishedAt: date, progress: 100, result, error: Prisma.DbNull });
      successResult = result;
      if (deleteOn === "success" || deleteOn === "always") {
        await job.delete();
      }
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
          error: serializeError(error),
          notBefore: null,
        });
      }
      errorResult = error;
      if (deleteOn === "failure" || deleteOn === "always") {
        await job.delete();
      }
    }

    return { job, successResult, errorResult };
  }

  /**
   * Requeues stale jobs that were claimed but never completed (e.g., due to a process crash
   * in non-transactional mode). Resets `processedAt` to null for jobs older than the cutoff.
   * @param options.olderThanMs - Only requeue jobs claimed more than this many milliseconds ago.
   * @returns The number of jobs requeued.
   */
  public async requeueStale(options: { olderThanMs: number }): Promise<number> {
    const cutoff = new Date(Date.now() - options.olderThanMs);
    const { count } = await this.model.updateMany({
      where: {
        queue: this.name,
        processedAt: { lte: cutoff },
        finishedAt: null,
      },
      data: { processedAt: null },
    });
    return count;
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
    const where: Prisma.QueueJobWhereInput = { queue: queueName, finishedAt: null };
    if (onlyAvailable) {
      where.runAt = { lte: date };
      where.processedAt = null;
      where.AND = { OR: [{ notBefore: { lte: date } }, { notBefore: null }] };
    }
    return await this.model.count({
      where,
    });
  }
}
