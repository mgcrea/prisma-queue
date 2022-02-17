import {PrismaClient} from '@prisma/client';
import {PrismaQueue} from 'src/index';
import {PrismaJob} from 'src/PrismaJob';
import {debug, serializeError} from 'src/utils';
import {createEmailQueue, JobPayload, JobResult, prisma, waitForNextJob, waitForNthJob} from 'test/utils';

describe('PrismaQueue', () => {
  it('should properly create a queue', () => {
    const emailQueue = createEmailQueue();
    expect(emailQueue).toBeDefined();
    expect(Object.keys(emailQueue)).toMatchSnapshot();
  });
  describe('enqueue', () => {
    let queue: PrismaQueue<JobPayload, JobResult>;
    beforeAll(() => {
      queue = createEmailQueue();
    });
    it('should properly enqueue a job', async () => {
      const job = await queue.enqueue({email: 'foo@bar.com'});
      expect(job).toBeInstanceOf(PrismaJob);
      expect(Object.keys(job)).toMatchSnapshot();
      const record = await job.fetch();
      expect(record?.payload).toEqual({email: 'foo@bar.com'});
      expect(record?.runAt).toBeInstanceOf(Date);
    });
  });

  describe('schedule', () => {
    let queue: PrismaQueue<JobPayload, JobResult>;
    beforeAll(async () => {
      await prisma.queueJob.deleteMany();
      queue = createEmailQueue();
    });
    it('should properly schedule a recurring job', async () => {
      const job = await queue.schedule({key: 'email-schedule', cron: '5 5 * * *'}, {email: 'foo@bar.com'});
      expect(job).toBeInstanceOf(PrismaJob);
      const record = await job.fetch();
      expect(record?.runAt.getHours()).toEqual(5);
      expect(record?.runAt.getMinutes()).toEqual(5);
    });
    it('should properly upsert a recurring job', async () => {
      await queue.schedule({key: 'email-schedule', cron: '5 5 * * *'}, {email: 'foo@bar.com'});
      await queue.schedule({key: 'email-schedule', cron: '5 5 * * *'}, {email: 'baz@bar.com'});
      const jobs = await prisma.queueJob.findMany({where: {key: 'email-schedule'}});
      expect(jobs.length).toEqual(1);
      expect(jobs[0].payload).toEqual({email: 'baz@bar.com'});
    });
    it('should properly upsert a recurring job with another schedule', async () => {
      await queue.schedule({key: 'email-schedule', cron: '5 5 * * *'}, {email: 'foo@bar.com'});
      await queue.schedule({key: 'email-schedule', cron: '0 5 * * *'}, {email: 'foo@bar.com'});
      const jobs = await prisma.queueJob.findMany({where: {key: 'email-schedule'}});
      expect(jobs.length).toEqual(1);
      expect(jobs[0].runAt.getMinutes()).toEqual(0);
    });
  });

  describe('dequeue', () => {
    let queue: PrismaQueue<JobPayload, JobResult>;
    beforeAll(async () => {
      await prisma.queueJob.deleteMany();
      queue = createEmailQueue();
      const promise = queue.start();
      expect(promise instanceof Promise);
    });
    it('should properly dequeue a successful job', async () => {
      queue.worker = jest.fn(async (_job) => {
        return {code: '200'};
      });
      const job = await queue.enqueue({email: 'foo@bar.com'});
      await waitForNextJob(queue);
      expect(queue.worker).toBeCalledTimes(1);
      expect(queue.worker).toHaveBeenNthCalledWith(1, expect.any(PrismaJob), expect.any(PrismaClient));
      const record = await job.fetch();
      expect(record?.finishedAt).toBeInstanceOf(Date);
    });
    it('should properly dequeue a failed job', async () => {
      let error: Error | null = null;
      queue.worker = jest.fn(async (_job) => {
        error = new Error('failed');
        throw error;
      });
      const job = await queue.enqueue({email: 'foo@bar.com'});
      await waitForNextJob(queue);
      expect(queue.worker).toBeCalledTimes(1);
      expect(queue.worker).toHaveBeenNthCalledWith(1, expect.any(PrismaJob), expect.any(PrismaClient));
      const record = await job.fetch();
      expect(record?.finishedAt).toBe(null);
      expect(record?.error).toEqual(serializeError(error));
    });
    afterAll(() => {
      queue.stop();
    });
  });

  describe('priority', () => {
    let queue: PrismaQueue<JobPayload, JobResult>;
    beforeAll(async () => {
      await prisma.queueJob.deleteMany();
      queue = createEmailQueue();
    });
    it('should properly prioritize a job with a lower priority', async () => {
      queue.worker = jest.fn(async (_job) => {
        return {code: '200'};
      });
      await queue.enqueue({email: 'foo@bar.com'});
      await queue.enqueue({email: 'baz@bar.com'}, {priority: -1});
      queue.start();
      await waitForNthJob(queue, 2);
      expect(queue.worker).toBeCalledTimes(2);
      expect(queue.worker).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          record: expect.objectContaining({payload: {email: 'baz@bar.com'}}),
        }),
        expect.any(PrismaClient)
      );
      expect(queue.worker).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          record: expect.objectContaining({payload: {email: 'foo@bar.com'}}),
        }),
        expect.any(PrismaClient)
      );
    });
    afterAll(() => {
      queue.stop();
    });
  });

  describe('Job.progress()', () => {
    let queue: PrismaQueue<JobPayload, JobResult>;
    beforeAll(async () => {
      await prisma.queueJob.deleteMany();
      queue = createEmailQueue();
      const promise = queue.start();
      expect(promise instanceof Promise);
    });
    it('should properly update job progress', async () => {
      queue.worker = jest.fn(async (job) => {
        debug('working...', job.id, job.payload);
        await job.progress(50);
        throw new Error('failed');
      });
      const job = await queue.enqueue({email: 'foo@bar.com'});
      await waitForNextJob(queue);
      const record = await job.fetch();
      expect(record?.progress).toEqual(50);
    });
    afterAll(() => {
      queue.stop();
    });
  });
});
