import {Prisma, PrismaClient} from '@prisma/client';
import assert from 'assert';
import Cron from 'croner';
import {EventEmitter} from 'events';
import {PrismaJob} from './PrismaJob';
import {DatabaseJob, JobCreator, JobPayload, JobResult, JobWorker} from './types';
import {calculateDelay, debug, escape, getTableName, serializeError, waitFor} from './utils';

export type PrismaQueueOptions<T, U> = {
  prisma?: PrismaClient;
  name?: string;
  maxConcurrency?: number;
  pollInterval?: number;
  // jobInterval?: number;
  tableName?: string;
};

export type EnqueueOptions = {
  runAt?: Date;
  key?: string;
  maxAttempts?: number;
  priority?: number;
};
export type ScheduleOptions = Omit<EnqueueOptions, 'key' | 'runAt'> & {
  key: string;
  cron: string;
};

const JOB_INTERVAL = 25;

export class PrismaQueue<T extends JobPayload = JobPayload, U extends JobResult = JobResult> extends EventEmitter {
  private name: string;
  private prisma: PrismaClient;
  private config: Required<Omit<PrismaQueueOptions<T, U>, 'name' | 'prisma'>>;

  private count = 0;
  private concurrency = 0;
  private stopped = true;

  public constructor(private options: PrismaQueueOptions<T, U> = {}, public worker?: JobWorker<T, U>) {
    super();

    const {
      prisma = new PrismaClient(),
      name = 'default',
      tableName = getTableName('QueueJob'),
      maxConcurrency = 1,
      pollInterval = 10000,
      // jobInterval = 100,
    } = options;

    assert(name.length <= 255, 'name must be less or equal to 255 chars');
    assert(pollInterval >= 100, 'pollInterval must be more than 100 ms');
    // assert(jobInterval >= 10, 'jobInterval must be more than 10 ms');

    this.name = name;
    this.prisma = prisma;
    this.config = {
      tableName,
      maxConcurrency,
      pollInterval,
      // jobInterval,
    };
  }

  private get model() {
    return this.prisma.queueJob;
  }

  public async start(): Promise<void> {
    this.stopped = false;
    return this.poll();
  }

  public async stop(): Promise<void> {
    this.stopped = true;
  }

  public async enqueue(payloadOrFunction: T | JobCreator<T>, options: EnqueueOptions = {}): Promise<PrismaJob<T, U>> {
    debug(`enqueue(${JSON.stringify(payloadOrFunction)})`);
    const {prisma, name: queueName} = this;
    const {key, maxAttempts, priority = 0, runAt} = options;
    const record = await prisma.$transaction(async (client) => {
      const payload = payloadOrFunction instanceof Function ? await payloadOrFunction(client) : payloadOrFunction;
      const data = {queue: queueName, payload, maxAttempts, priority, runAt};
      if (key && runAt) {
        const {count} = await this.model.deleteMany({
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
        return await this.model.upsert({
          where: {key_runAt: {key, runAt}},
          create: {key, ...data},
          update: data,
        });
      }
      return await this.model.create({data});
    });
    return new PrismaJob(record as DatabaseJob<T, U>, {prisma});
  }

  public async schedule(options: ScheduleOptions, payloadOrFunction: T | JobCreator<T>): Promise<PrismaJob<T, U>> {
    debug(`schedule(${JSON.stringify(options)})`);
    const {key, cron, ...otherOptions} = options;
    const runAt = Cron(cron).next();
    assert(runAt, `Failed to find a future occurence for given cron`);
    return this.enqueue(payloadOrFunction, {key, runAt, ...otherOptions});
  }

  private async poll(): Promise<void> {
    if (this.stopped) {
      return;
    }
    const {maxConcurrency, pollInterval} = this.config;
    let estimatedQueueSize = await this.size();
    while (estimatedQueueSize > 0) {
      while (estimatedQueueSize > 0 && this.concurrency < maxConcurrency) {
        estimatedQueueSize--;
        this.concurrency++;
        setImmediate(() =>
          this.dequeue()
            .then((count) => {
              if (count === 0) {
                estimatedQueueSize = 0;
              }
            })
            .catch((err) => this.emit('error', err))
            .finally(() => this.concurrency--)
        );
      }

      await waitFor(JOB_INTERVAL);
    }

    debug(`poll waiting for pollInterval=${pollInterval}`);
    await waitFor(pollInterval);

    await this.poll();
  }

  // https://www.2ndquadrant.com/en/blog/what-is-select-skip-locked-for-in-postgresql-9-5/
  // @TODO https://docs.quirrel.dev/api/queue
  // https://github.com/quirrel-dev/quirrel/blob/main/package.json
  private async dequeue(): Promise<number | undefined> {
    debug(`dequeue()`);
    if (this.stopped) {
      return;
    }
    const {prisma, name: queueName} = this;
    const tableName = escape(this.config.tableName);
    return await prisma.$transaction(
      async (client) => {
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
          queueName
        );
        // d({ rows });
        if (rows.length < 1) {
          return 0;
        }
        const {id, payload, attempts} = rows[0];
        const job = new PrismaJob(rows[0], {prisma: client});
        let result;
        try {
          assert(this.worker, 'Missing queue worker to process job');
          debug(`starting worker for job({id: ${id}, payload: ${JSON.stringify(payload)}})`);
          result = await this.worker(job, prisma);
          await client.queueJob.update({
            where: {id: id},
            data: {finishedAt: new Date(), progress: 100, result, error: Prisma.DbNull},
          });
        } catch (err) {
          debug(`failed finishing job({id: ${id}, payload: ${JSON.stringify(payload)}}) with error="${err}"`);
          const delay = calculateDelay(attempts);
          const nextRunAt = new Date(Date.now() + delay);
          debug(`will retry at runAt=${nextRunAt.toISOString()} (attempts=${attempts})`);
          await client.queueJob.update({
            where: {id: id},
            data: {
              failedAt: new Date(),
              error: serializeError(err),
              notBefore: new Date(Date.now() + calculateDelay(attempts)),
            },
          });
        }
        return rows.length;
      },
      // @NOTE https://github.com/prisma/prisma/issues/11565#issuecomment-1031380271
      {timeout: 864e5}
    );
  }

  public async size(): Promise<number> {
    const {prisma, name: queueName} = this;
    return await prisma.queueJob.count({where: {queue: queueName, finishedAt: null}});
  }
}
