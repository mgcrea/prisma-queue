import {Prisma, PrismaClient, QueueJob as PrismaQueueJob} from '@prisma/client';
import assert from 'assert';
import {EventEmitter} from 'events';
import {waitFor, debug, escape} from './utils';

// https://github.com/graphile/worker
// https://github.com/Hexagon/croner

export type PrismaQueueOptions = {
  name?: string;
  concurrency?: number;
  pollInterval?: number;
  tableName?: string;
};

export type JobPayload = Prisma.InputJsonValue;
export type JobResult = Prisma.InputJsonValue;
export type JobProcessor<T extends JobPayload = JobPayload, U extends JobResult = JobResult> = (
  payload: T,
  client: PrismaClient
) => Promise<U>;
export type PrismaLightClient = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use'>;
export type JobCreator<T extends JobPayload> = (client: PrismaLightClient) => Promise<T>;
export type QueueJob<T, U> = Omit<PrismaQueueJob, 'payload' | 'result'> & {payload: T; result: U};
export type EnqueueOptions = {
  maxAttempts?: number;
  priority?: number;
};

export class PrismaQueue<T extends JobPayload = JobPayload, U extends JobResult = JobResult> extends EventEmitter {
  private maxConcurrency: number;
  private pollInterval: number;

  private name: string;
  private tableName: string;

  private count = 0;
  private concurrency = 0;
  private stopped = true;

  public constructor(
    private prisma: PrismaClient,
    private processor: JobProcessor<T, U>,
    {tableName = 'queue_jobs', name = 'default', concurrency = 1, pollInterval = 10000}: PrismaQueueOptions = {}
  ) {
    super();
    assert(name.length <= 255, 'name must be less or equal to 255 chars');
    assert(pollInterval >= 100, 'pollInterval must be more than 100 ms');

    this.maxConcurrency = concurrency;
    this.pollInterval = pollInterval;
    this.name = name;
    this.tableName = tableName;
  }

  public async start() {
    this.stopped = false;
    this.poll();
  }

  public async stop() {
    this.stopped = true;
  }

  public async size(): Promise<number> {
    const {prisma, name: queueName} = this;
    return await prisma.queueJob.count({where: {queue: queueName, finishedAt: null}});
  }

  public async enqueue(payloadOrFunction: T | JobCreator<T>, options: EnqueueOptions = {}): Promise<PrismaQueueJob> {
    debug('enqueue');
    const {prisma, name: queueName} = this;
    const {maxAttempts, priority = 0} = options;
    return await prisma.$transaction(async (prisma) => {
      const payload = payloadOrFunction instanceof Function ? await payloadOrFunction(prisma) : payloadOrFunction;
      return await prisma.queueJob.create({data: {queue: queueName, payload, maxAttempts, priority}});
    });
  }

  private async poll() {
    debug('poll');
    if (this.stopped) {
      return;
    }

    let estimatedQueueSize = await this.size();

    while (estimatedQueueSize > 0) {
      while (estimatedQueueSize > 0 && this.concurrency < this.maxConcurrency) {
        estimatedQueueSize--;
        this.concurrency++;
        setImmediate(() =>
          this.dequeue()
            .then((count) => {
              debug(`then count=${count}`);
              if (count === 0) {
                estimatedQueueSize = 0;
              }
            })
            .catch((err) => this.emit('error', err))
            .finally(() => this.concurrency--)
        );
      }

      await waitFor(25);
    }

    debug('waitFor poll', this.pollInterval);
    await waitFor(this.pollInterval);

    await this.poll();
  }

  // https://www.2ndquadrant.com/en/blog/what-is-select-skip-locked-for-in-postgresql-9-5/
  // @TODO https://docs.quirrel.dev/api/queue
  // https://github.com/quirrel-dev/quirrel/blob/main/package.json
  private async dequeue(): Promise<number | undefined> {
    this.count++;
    debug(`dequeue #${this.count}`);
    if (this.stopped) {
      return;
    }
    const {prisma, name: queueName, tableName} = this;
    // d('dequeue', { tableName, queueName, date: new Date() });
    return await prisma.$transaction(
      async (client) => {
        const rows = await client.$queryRawUnsafe<QueueJob<T, U>[]>(
          // `DELETE FROM ${escape(tableName)}
          `UPDATE ${escape(tableName)} SET "processedAt" = NOW(), "attempts" = "attempts" + 1
         WHERE id = (
           SELECT id
           FROM ${escape(tableName)}
           WHERE (${escape(tableName)}."queue" = $1)
            AND (${escape(tableName)}."runAt" < NOW())
            AND (${escape(tableName)}."finishedAt" IS NULL)
           ORDER BY ${escape(tableName)}."runAt" ASC, ${escape(tableName)}."priority" ASC
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         RETURNING *;`,
          queueName
        );
        // d({ rows });
        debug(`dequeued ${rows.length}`);
        if (rows.length < 1) {
          return 0;
        }
        const {id, payload, attempts} = rows[0];
        let result;
        try {
          result = await this.processor(payload, prisma);
          await client.queueJob.update({
            where: {id: id},
            data: {finishedAt: new Date(), progress: 100, result, error: Prisma.DbNull},
          });
        } catch (err) {
          const delay = calculateDelay(attempts);
          debug(`delay=${delay} for attempts=${attempts}`);
          await client.queueJob.update({
            where: {id: id},
            data: {
              failedAt: new Date(),
              error: serializeError(err),
              runAt: new Date(Date.now() + calculateDelay(attempts)),
            },
          });
        }
        return rows.length;
      },
      // @NOTE https://github.com/prisma/prisma/issues/11565#issuecomment-1031380271
      {timeout: 864e5}
    );
  }
}

export const createQueue = <T extends JobPayload = JobPayload, U extends JobResult = JobResult>(
  options: {prisma: PrismaClient} & PrismaQueueOptions,
  processor: JobProcessor<T, U>
) => {
  return new PrismaQueue<T, U>(options.prisma, processor, options);
};

const serializeError = (err: unknown) => {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
    };
  }
  return {
    name: 'UnknownError',
    message: `${err}`,
    stack: undefined,
  };
};

const calculateDelay = (attempts: number): number =>
  Math.min(1000 * Math.pow(2, Math.max(1, attempts)) + Math.random() * 100, Math.pow(2, 31) - 1);
