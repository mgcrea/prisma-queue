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
  waitFor,
} from "./utils";

export type PrismaQueueOptions = {
  prisma?: PrismaClient;
  name?: string;
  maxConcurrency?: number;
  pollInterval?: number;
  jobInterval?: number;
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

const DEFAULT_MAX_CONCURRENCY = 1;
const DEFAULT_POLL_INTERVAL = 10 * 1000;
const DEFAULT_JOB_INTERVAL = 25;
const DEFAULT_DELETE_ON = "never";

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
    public worker?: JobWorker<T, U>,
  ) {
    super();

    const {
      prisma = new PrismaClient(),
      name = "default",
      tableName = getTableName("QueueJob"),
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
      tableName,
      maxConcurrency,
      pollInterval,
      jobInterval,
      deleteOn,
      alignTimeZone,
    };
  }

  private get model() {
    return this.#prisma.queueJob;
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
    const job = new PrismaJob(record as DatabaseJob<T, U>, { prisma: this.#prisma });
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
      let estimatedQueueSize = await this.size();

      while (estimatedQueueSize > 0 && this.concurrency < maxConcurrency) {
        estimatedQueueSize--;
        this.concurrency++;
        setImmediate(() =>
          this.dequeue()
            .then((job) => {
              if (!job) {
                estimatedQueueSize = 0;
              }
            })
            .catch((err) => this.emit("error", err))
            .finally(() => this.concurrency--),
        );
        await waitFor(jobInterval);
      }

      await waitFor(pollInterval);
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
          // @NOTE Failed to acquire a lock
          return null;
        }
        const { id, payload, attempts, maxAttempts } = rows[0];
        const job = new PrismaJob<T, U>(rows[0], { prisma: client });
        let result;
        try {
          assert(this.worker, "Missing queue worker to process job");
          debug(`starting worker for job({id: ${id}, payload: ${JSON.stringify(payload)}})`);
          result = await this.worker(job, this.#prisma);
          const date = new Date();
          await job.update({ finishedAt: date, progress: 100, result, error: Prisma.DbNull });
          this.emit("job:success", job);
          if (deleteOn === "success" || deleteOn === "always") {
            await job.delete();
          }
        } catch (err) {
          const date = new Date();
          debug(`failed finishing job({id: ${id}, payload: ${JSON.stringify(payload)}}) with error="${err}"`);
          const isFinished = maxAttempts && attempts >= maxAttempts;
          const notBefore = new Date(date.getTime() + calculateDelay(attempts));
          if (!isFinished) {
            debug(`will retry at notBefore=${notBefore.toISOString()} (attempts=${attempts})`);
          }
          await job.update({
            finishedAt: isFinished ? date : null,
            failedAt: date,
            error: serializeError(err),
            notBefore: isFinished ? null : notBefore,
          });
          this.emit("job:error", job);
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
    return await this.#prisma.queueJob.count({ where: { queue: queueName, finishedAt: null } });
  }
}
