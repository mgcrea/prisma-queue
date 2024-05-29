import { Prisma, PrismaClient } from "@prisma/client";
import Cron from "croner";
import { EventEmitter } from "events";
import assert from "node:assert";
import { PrismaJob } from "./PrismaJob";
import type { DatabaseJob, JobCreator, JobPayload, JobResult, JobWorker } from "./types";
import {
  calculateDelay,
  debug,
  escape,
  getCurrentTimeZone,
  getTableName,
  serializeError,
  uncapitalize,
  waitFor,
} from "./utils";

export type PrismaQueueOptions = {
  prisma?: PrismaClient;
  name?: string;
  maxConcurrency?: number;
  pollInterval?: number;
  jobInterval?: number;
  modelName?: string;
  tableName?: string;
  deleteOn?: "success" | "failure" | "always" | "never";
  alignTimeZone?: boolean;
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
  error: (error: unknown, job?: PrismaJob<T, U>) => void;
};

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
const DEFAULT_JOB_INTERVAL = 25;
const DEFAULT_DELETE_ON = "never";

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class PrismaQueue<
  T extends JobPayload = JobPayload,
  U extends JobResult = JobResult,
> extends EventEmitter {
  #prisma: PrismaClient;
  private name: string;
  private config: Required<Omit<PrismaQueueOptions, "name" | "prisma">>;

  private concurrency = 0;
  private stopped = true;

  public constructor(
    private options: PrismaQueueOptions = {},
    public worker: JobWorker<T, U>,
  ) {
    super();

    const {
      prisma = new PrismaClient(),
      name = "default",
      modelName = "QueueJob",
      tableName = getTableName(modelName),
      maxConcurrency = DEFAULT_MAX_CONCURRENCY,
      pollInterval = DEFAULT_POLL_INTERVAL,
      jobInterval = DEFAULT_JOB_INTERVAL,
      deleteOn = DEFAULT_DELETE_ON,
      alignTimeZone = false,
    } = this.options;

    assert(name.length <= 255, "name must be less or equal to 255 chars");
    assert(pollInterval >= 100, "pollInterval must be more than 100 ms");
    assert(jobInterval >= 10, "jobInterval must be more than 10 ms");

    this.name = name;
    this.#prisma = prisma;
    this.config = {
      modelName,
      tableName,
      maxConcurrency,
      pollInterval,
      jobInterval,
      deleteOn,
      alignTimeZone,
    };

    // Default error handler
    this.on("error", (error, job) =>
      debug(
        job
          ? `Job with id=${job.id} failed for queue named="${this.name}" with error`
          : `Queue named="${this.name}" encountered an unexpected error`,
        error,
      ),
    );
  }

  private get model(): Prisma.QueueJobDelegate {
    const queueJobKey = uncapitalize(this.config.modelName) as "queueJob";
    return this.#prisma[queueJobKey];
  }

  public async start(): Promise<void> {
    debug(`start`, this.name);
    this.stopped = false;
    return this.poll();
  }

  public async stop(): Promise<void> {
    debug(`stop`, this.name);
    this.stopped = true;
  }

  public async enqueue(
    payloadOrFunction: T | JobCreator<T>,
    options: EnqueueOptions = {},
  ): Promise<PrismaJob<T, U>> {
    debug(`enqueue`, this.name, payloadOrFunction, options);
    const { name: queueName } = this;
    const { key, cron = null, maxAttempts = null, priority = 0, runAt } = options;
    const record = await this.#prisma.$transaction(async (client) => {
      const payload =
        payloadOrFunction instanceof Function ? await payloadOrFunction(client) : payloadOrFunction;
      const data = { queue: queueName, cron, payload, maxAttempts, priority };
      if (key && runAt) {
        const { count } = await this.model.deleteMany({
          where: {
            key,
            runAt: {
              gte: new Date(),
              not: runAt,
            },
          },
        });
        if (count > 0) {
          debug(`deleted ${count} conflicting upcoming queue jobs`);
        }
        const update = { ...data, ...(runAt ? { runAt } : {}) };
        return await this.model.upsert({
          where: { key_runAt: { key, runAt } },
          create: { key, ...update },
          update,
        });
      }
      return await this.model.create({ data });
    });
    const job = new PrismaJob(record as DatabaseJob<T, U>, { model: this.model, client: this.#prisma });
    this.emit("enqueue", job);
    return job;
  }

  public async schedule(
    options: ScheduleOptions,
    payloadOrFunction: T | JobCreator<T>,
  ): Promise<PrismaJob<T, U>> {
    debug(`schedule`, this.name, options, payloadOrFunction);
    const { key, cron, runAt: firstRunAt, ...otherOptions } = options;
    const runAt = firstRunAt || Cron(cron).nextRun();
    assert(runAt, `Failed to find a future occurence for given cron`);
    return this.enqueue(payloadOrFunction, { key, cron, runAt, ...otherOptions });
  }

  private async poll(): Promise<void> {
    debug(`poll`, this.name);
    const { maxConcurrency, pollInterval, jobInterval } = this.config;

    while (!this.stopped) {
      // Ensure that poll waits when no immediate jobs need processing.
      if (this.concurrency >= maxConcurrency) {
        await waitFor(pollInterval);
        continue;
      }
      // Query the queue size only when needed to reduce database load.
      let estimatedQueueSize = await this.size();
      if (estimatedQueueSize === 0) {
        await waitFor(pollInterval);
        continue;
      }

      while (this.concurrency < maxConcurrency && estimatedQueueSize > 0) {
        this.concurrency++;
        setImmediate(() =>
          this.dequeue()
            .then((job) => {
              if (!job) {
                estimatedQueueSize = 0;
              } else {
                estimatedQueueSize--;
              }
            })
            .catch((error) => this.emit("error", error))
            .finally(() => {
              this.concurrency--;
            }),
        );
        await waitFor(jobInterval);
      }
    }
  }

  // https://www.2ndquadrant.com/en/blog/what-is-select-skip-locked-for-in-postgresql-9-5/
  // @TODO https://docs.quirrel.dev/api/queue
  // https://github.com/quirrel-dev/quirrel/blob/main/package.json
  private async dequeue(): Promise<PrismaJob<T, U> | null> {
    if (this.stopped) {
      return null;
    }
    debug(`dequeue`, this.name);
    const { name: queueName } = this;
    const { tableName: tableNameRaw, deleteOn, alignTimeZone } = this.config;
    const tableName = escape(tableNameRaw);
    const queueJobKey = uncapitalize(this.config.modelName) as "queueJob";
    const job = await this.#prisma.$transaction(
      async (client) => {
        if (alignTimeZone) {
          const [{ TimeZone: dbTimeZone }] =
            await client.$queryRawUnsafe<[{ TimeZone: string }]>("SHOW TIME ZONE");
          const localTimeZone = getCurrentTimeZone();
          if (dbTimeZone !== localTimeZone) {
            debug(`aligning database timezone from ${dbTimeZone} to ${localTimeZone}!`);
            await client.$executeRawUnsafe(`SET LOCAL TIME ZONE '${localTimeZone}';`);
          }
        }
        const rows = await client.$queryRawUnsafe<DatabaseJob<T, U>[]>(
          `UPDATE ${tableName} SET "processedAt" = NOW(), "attempts" = "attempts" + 1
           WHERE id = (
             SELECT id
             FROM ${tableName}
             WHERE (${tableName}."queue" = $1)
               AND (${tableName}."runAt" < NOW())
               AND (${tableName}."finishedAt" IS NULL)
               AND (${tableName}."notBefore" IS NULL OR ${tableName}."notBefore" < NOW())
             ORDER BY ${tableName}."priority" ASC, ${tableName}."runAt" ASC
             FOR UPDATE SKIP LOCKED
             LIMIT 1
           )
           RETURNING *;`,
          queueName,
        );
        if (!rows.length || !rows[0]) {
          debug(`no job found to process`);
          // @NOTE Failed to acquire a lock
          return null;
        }
        const { id, payload, attempts, maxAttempts } = rows[0];
        const job = new PrismaJob<T, U>(rows[0], { model: client[queueJobKey], client });
        let result;
        try {
          assert(this.worker, "Missing queue worker to process job");
          debug(`starting worker for job({id: ${id}, payload: ${JSON.stringify(payload)}})`);
          result = await this.worker(job, this.#prisma);
          const date = new Date();
          await job.update({ finishedAt: date, progress: 100, result, error: Prisma.DbNull });
          this.emit("success", result, job);
          if (deleteOn === "success" || deleteOn === "always") {
            await job.delete();
          }
        } catch (error) {
          const date = new Date();
          debug(
            `failed finishing job({id: ${id}, payload: ${JSON.stringify(payload)}}) with error="${error}"`,
          );
          const isFinished = maxAttempts && attempts >= maxAttempts;
          const notBefore = new Date(date.getTime() + calculateDelay(attempts));
          if (!isFinished) {
            debug(`will retry at notBefore=${notBefore.toISOString()} (attempts=${attempts})`);
          }
          await job.update({
            finishedAt: isFinished ? date : null,
            failedAt: date,
            error: serializeError(error),
            notBefore: isFinished ? null : notBefore,
          });
          this.emit("error", error, job);
          if (deleteOn === "failure" || deleteOn === "always") {
            await job.delete();
          }
        }
        return job;
      },
      // @NOTE https://github.com/prisma/prisma/issues/11565#issuecomment-1031380271
      { timeout: 864e5 },
    );
    if (job) {
      this.emit("dequeue", job);
      const { key, cron, payload, finishedAt } = job;
      if (finishedAt && cron && key) {
        // Schedule next cron
        await this.schedule({ key, cron }, payload);
      }
    }

    return job;
  }

  public async size(): Promise<number> {
    const { name: queueName } = this;
    return await this.model.count({
      where: { queue: queueName, finishedAt: null },
    });
  }
}
