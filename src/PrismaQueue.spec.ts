import type { PrismaClient } from "@prisma/client";
import type { PrismaQueue } from "src/index";
import { PrismaJob } from "src/PrismaJob";
import { debug, serializeError, waitFor } from "src/utils";
import {
  createEmailQueue,
  createEmailQueueNonTransactional,
  DEFAULT_POLL_INTERVAL,
  prisma,
  waitForNextEvent,
  waitForNextJob,
  waitForNthJob,
  type EmailJob,
  type EmailJobPayload,
  type EmailJobResult,
} from "test/utils";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const AnyPrismaClient = expect.any(Object);

describe("PrismaQueue", () => {
  it("should properly create a queue", () => {
    const emailQueue = createEmailQueue();
    expect(emailQueue).toBeDefined();
    expect(Object.keys(emailQueue)).toMatchInlineSnapshot(`
      [
        "_events",
        "_eventsCount",
        "_maxListeners",
        "name",
        "config",
        "concurrency",
        "stopped",
        "abortController",
        "add",
        "options",
        "worker",
      ]
    `);
  });
  describe("enqueue", () => {
    let queue: PrismaQueue<EmailJobPayload, EmailJobResult>;
    beforeAll(() => {
      queue = createEmailQueue();
    });
    beforeEach(async () => {
      await prisma.queueJob.deleteMany();
      void queue.start();
    });
    afterEach(() => {
      void queue.stop();
    });
    it("should properly enqueue a job", async () => {
      const job = await queue.enqueue({ email: "foo@bar.com" });
      expect(job).toBeInstanceOf(PrismaJob);
      expect(Object.keys(job)).toMatchInlineSnapshot(`
        [
          "id",
          "createdAt",
          "signal",
        ]
      `);
      const record = await job.fetch();
      expect(record.key).toBeNull();
      expect(record.payload).toEqual({ email: "foo@bar.com" });
      expect(record.runAt).toBeInstanceOf(Date);
    });

    it("should properly enqueue a job with a custom key", async () => {
      const job = await queue.enqueue({ email: "foo@bar.com" }, { key: "custom-key" });
      expect(job).toBeInstanceOf(PrismaJob);
      expect(Object.keys(job)).toMatchInlineSnapshot(`
        [
          "id",
          "createdAt",
          "signal",
        ]
      `);
      const record = await job.fetch();
      expect(record.payload).toEqual({ email: "foo@bar.com" });
      expect(record.runAt).toBeInstanceOf(Date);
      expect(record.key).toBe("custom-key");
    });
  });

  describe("schedule", () => {
    let queue: PrismaQueue<EmailJobPayload, EmailJobResult>;
    beforeAll(() => {
      queue = createEmailQueue();
    });
    beforeEach(async () => {
      await prisma.queueJob.deleteMany();
      void queue.start();
    });
    afterEach(() => {
      void queue.stop();
    });
    it("should properly schedule a recurring job", async () => {
      const job = await queue.schedule(
        { key: "email-schedule", cron: "5 5 * * *" },
        { email: "foo@bar.com" },
      );
      expect(job).toBeInstanceOf(PrismaJob);
      const record = await job.fetch();
      expect(record).toBeDefined();
      expect(record.runAt.getHours()).toBe(5);
      expect(record.runAt.getMinutes()).toBe(5);
    });
    it("should properly re-enqueue a recurring job", async () => {
      await queue.schedule(
        { key: "email-schedule", cron: "5 5 * * *", runAt: new Date() },
        { email: "foo@bar.com" },
      );
      void queue.start();
      await waitForNextEvent(queue, "enqueue");
      const jobs = await prisma.queueJob.findMany({ where: { key: "email-schedule" } });
      expect(jobs.length).toBe(2);
      const record = jobs[1];
      expect(record).toBeDefined();
      expect(record?.runAt.getHours()).toBe(5);
      expect(record?.runAt.getMinutes()).toBe(5);
    });
    it("should properly upsert a recurring job", async () => {
      await queue.schedule({ key: "email-schedule", cron: "5 5 * * *" }, { email: "foo@bar.com" });
      await queue.schedule({ key: "email-schedule", cron: "5 5 * * *" }, { email: "baz@bar.com" });
      const jobs = await prisma.queueJob.findMany({ where: { key: "email-schedule" } });
      expect(jobs.length).toBe(1);
      expect(jobs[0]?.payload).toEqual({ email: "baz@bar.com" });
    });
    it("should properly upsert a recurring job with another schedule", async () => {
      await queue.schedule({ key: "email-schedule", cron: "5 5 * * *" }, { email: "foo@bar.com" });
      await queue.schedule({ key: "email-schedule", cron: "0 5 * * *" }, { email: "foo@bar.com" });
      const jobs = await prisma.queueJob.findMany({ where: { key: "email-schedule" } });
      expect(jobs.length).toBe(1);
      expect(jobs[0]?.runAt.getMinutes()).toBe(0);
    });
  });

  describe("dequeue", () => {
    let queue: PrismaQueue<EmailJobPayload, EmailJobResult>;
    beforeAll(() => {
      queue = createEmailQueue();
    });
    beforeEach(async () => {
      await prisma.queueJob.deleteMany();
      void queue.start();
    });
    afterEach(() => {
      void queue.stop();
    });
    it("should properly dequeue a successful job", async () => {
      queue.worker = vi.fn(async (_job, _client) => {
        await waitFor(200);
        return { code: "200" };
      });
      const job = await queue.enqueue({ email: "foo@bar.com" });
      await waitForNextJob(queue);
      expect(queue.worker).toHaveBeenCalledTimes(1);
      expect(queue.worker).toHaveBeenNthCalledWith(1, expect.any(PrismaJob), AnyPrismaClient);
      const record = await job.fetch();
      expect(record.finishedAt).toBeInstanceOf(Date);
    });
    it("should properly dequeue a failed job", async () => {
      let error: Error | null = null;
      // eslint-disable-next-line @typescript-eslint/require-await
      queue.worker = vi.fn(async (_job) => {
        error = new Error("failed");
        throw error;
      });
      const job = await queue.enqueue({ email: "foo@bar.com" });
      await waitForNextJob(queue);
      expect(queue.worker).toHaveBeenCalledTimes(1);
      expect(queue.worker).toHaveBeenNthCalledWith(1, expect.any(PrismaJob), AnyPrismaClient);
      const record = await job.fetch();
      expect(record.finishedAt).toBeNull();
      expect(record.error).toEqual(serializeError(error));
    });
    it("should properly dequeue multiple jobs in a row", async () => {
      const JOB_WAIT = 50;
      queue.worker = vi.fn(async (_job) => {
        await waitFor(JOB_WAIT);
        return { code: "200" };
      });
      await Promise.all([
        queue.enqueue({ email: "foo1@bar1.com" }),
        queue.enqueue({ email: "foo2@bar2.com" }),
      ]);
      await waitFor(DEFAULT_POLL_INTERVAL + JOB_WAIT * 2 + 100);
      expect(queue.worker).toHaveBeenCalledTimes(2);
      expect(queue.worker).toHaveBeenNthCalledWith(2, expect.any(PrismaJob), AnyPrismaClient);
    });
    it("should properly handle multiple restarts", async () => {
      const JOB_WAIT = 50;

      // Stop the queue that was started in beforeEach
      await queue.stop();

      queue.worker = vi.fn(async (_job: EmailJob) => {
        await waitFor(JOB_WAIT);
        return { code: "200" };
      });

      // Enqueue 2 jobs while stopped
      await Promise.all([
        queue.enqueue({ email: "foo1@bar1.com" }),
        queue.enqueue({ email: "foo2@bar2.com" }),
      ]);

      // Verify no jobs processed yet
      expect(queue.worker).toHaveBeenCalledTimes(0);

      // Start briefly and stop (simulating an interrupted start)
      void queue.start();
      await waitFor(10);
      await queue.stop();

      // May or may not have started processing
      const mockedWorker = queue.worker as ReturnType<typeof vi.fn>;
      const countAfterInterruption = mockedWorker.mock.calls.length;

      // Now properly start and let all jobs complete
      void queue.start();

      // Wait for the remaining jobs to complete
      const remainingJobs = 2 - countAfterInterruption;
      if (remainingJobs > 0) {
        await waitForNthJob(queue, remainingJobs);
      }

      // Eventually both jobs should be processed
      expect(mockedWorker.mock.calls.length).toBe(2);
    }, 10000); // Increase timeout for this test
    afterAll(() => {
      void queue.stop();
    });
  });

  describe("Job.signal", () => {
    let queue: PrismaQueue<EmailJobPayload, EmailJobResult>;
    beforeAll(() => {
      queue = createEmailQueue({ pollInterval: 200 });
    });
    beforeEach(async () => {
      await prisma.queueJob.deleteMany();
    });
    afterAll(() => {
      void queue.stop();
    });
    it("should expose a non-aborted signal on dequeued job", async () => {
      let signalAbortedDuringWork: boolean | undefined;
      // eslint-disable-next-line @typescript-eslint/require-await
      queue.worker = vi.fn(async (job: EmailJob) => {
        signalAbortedDuringWork = job.signal.aborted;
        return { code: "200" };
      });
      await queue.enqueue({ email: "foo@bar.com" });
      void queue.start();
      await waitForNextJob(queue);
      await queue.stop();
      expect(signalAbortedDuringWork).toBe(false);
    });
    it("should abort signal when queue is stopped", async () => {
      let jobSignal: AbortSignal | undefined;
      queue.worker = vi.fn(async (job: EmailJob) => {
        jobSignal = job.signal;
        await waitFor(2000);
        return { code: "200" };
      });
      await queue.enqueue({ email: "foo@bar.com" });
      void queue.start();
      await waitFor(400);
      expect(jobSignal).toBeDefined();
      expect(jobSignal?.aborted).toBe(false);
      await queue.stop({ timeout: 5000 });
      expect(jobSignal?.aborted).toBe(true);
    });
  });

  describe("retryStrategy", () => {
    it("should use custom retry strategy", async () => {
      const retryDelays: number[] = [];
      const queue = createEmailQueue({
        maxAttempts: 3,
        pollInterval: 200,
        retryStrategy: ({ attempts, maxAttempts }) => {
          if (maxAttempts !== null && attempts >= maxAttempts) return null;
          const delay = 100 * attempts;
          retryDelays.push(delay);
          return delay;
        },
      });
      await prisma.queueJob.deleteMany();
      // eslint-disable-next-line @typescript-eslint/require-await
      queue.worker = vi.fn(async () => {
        throw new Error("always fails");
      });
      await queue.enqueue({ email: "retry@test.com" });
      void queue.start();
      await waitForNthJob(queue, 3);
      await queue.stop();
      expect(queue.worker).toHaveBeenCalledTimes(3);
      expect(retryDelays).toEqual([100, 200]);
    });
    it("should stop retrying when strategy returns null", async () => {
      const queue = createEmailQueue({
        pollInterval: 200,
        retryStrategy: () => null,
      });
      await prisma.queueJob.deleteMany();
      // eslint-disable-next-line @typescript-eslint/require-await
      queue.worker = vi.fn(async () => {
        throw new Error("fails once");
      });
      const job = await queue.enqueue({ email: "no-retry@test.com" });
      void queue.start();
      await waitForNextJob(queue);
      await queue.stop();
      expect(queue.worker).toHaveBeenCalledTimes(1);
      const record = await job.fetch();
      expect(record.finishedAt).toBeInstanceOf(Date);
    });
  });

  describe("deleteOn", () => {
    let queue: PrismaQueue<EmailJobPayload, EmailJobResult>;
    describe("success", () => {
      beforeAll(() => {
        queue = createEmailQueue({ deleteOn: "success" });
      });
      beforeEach(async () => {
        await prisma.queueJob.deleteMany();
        void queue.start();
      });
      afterEach(() => {
        void queue.stop();
      });
      it("should properly dequeue a successful job", async () => {
        // eslint-disable-next-line @typescript-eslint/require-await
        queue.worker = vi.fn(async (_job) => {
          return { code: "200" };
        });
        const job = await queue.enqueue({ email: "foo@bar.com" });
        await waitForNextJob(queue);
        expect(queue.worker).toHaveBeenCalledTimes(1);
        const record = await job.fetch();
        expect(record).toBeNull();
      });
      afterAll(() => {
        void queue.stop();
      });
    });
    describe("failure", () => {
      beforeAll(() => {
        queue = createEmailQueue({ deleteOn: "failure" });
      });
      beforeEach(async () => {
        await prisma.queueJob.deleteMany();
        void queue.start();
      });
      afterEach(() => {
        void queue.stop();
      });
      it("should properly dequeue a failed job", async () => {
        let error: Error | null = null;
        // eslint-disable-next-line @typescript-eslint/require-await
        queue.worker = vi.fn(async (_job) => {
          error = new Error("failed");
          throw error;
        });
        const job = await queue.enqueue({ email: "foo@bar.com" });
        await waitForNextJob(queue);
        expect(queue.worker).toHaveBeenCalledTimes(1);
        const record = await job.fetch();
        expect(record).toBeNull();
      });
      afterAll(() => {
        void queue.stop();
      });
    });
    describe("always", () => {
      beforeAll(() => {
        queue = createEmailQueue({ deleteOn: "always" });
      });
      beforeEach(async () => {
        await prisma.queueJob.deleteMany();
        void queue.start();
      });
      afterEach(() => {
        void queue.stop();
      });
      it("should properly dequeue a successful job", async () => {
        // eslint-disable-next-line @typescript-eslint/require-await
        queue.worker = vi.fn(async (_job) => {
          return { code: "200" };
        });
        const job = await queue.enqueue({ email: "foo@bar.com" });
        await waitForNextJob(queue);
        expect(queue.worker).toHaveBeenCalledTimes(1);
        const record = await job.fetch();
        expect(record).toBeNull();
      });
      it("should properly dequeue a failed job", async () => {
        let error: Error | null = null;
        // eslint-disable-next-line @typescript-eslint/require-await
        queue.worker = vi.fn(async (_job) => {
          error = new Error("failed");
          throw error;
        });
        const job = await queue.enqueue({ email: "foo@bar.com" });
        await waitForNextJob(queue);
        expect(queue.worker).toHaveBeenCalledTimes(1);
        const record = await job.fetch();
        expect(record).toBeNull();
      });
      afterAll(() => {
        void queue.stop();
      });
    });
  });

  describe("maxConcurrency", () => {
    let queue: PrismaQueue<EmailJobPayload, EmailJobResult>;
    beforeAll(() => {
      queue = createEmailQueue({ maxConcurrency: 2 });
    });
    beforeEach(async () => {
      await prisma.queueJob.deleteMany();
      void queue.start();
    });
    afterEach(() => {
      void queue.stop();
    });
    it("should properly dequeue multiple jobs in a row according to maxConcurrency", async () => {
      const JOB_WAIT = 100;
      queue.worker = vi.fn(async (_job) => {
        await waitFor(JOB_WAIT);
        return { code: "200" };
      });
      await Promise.all([
        queue.enqueue({ email: "foo1@bar1.com" }),
        queue.enqueue({ email: "foo2@bar2.com" }),
      ]);
      await waitFor(DEFAULT_POLL_INTERVAL + 100);
      expect(queue.worker).toHaveBeenCalledTimes(2);
      expect(queue.worker).toHaveBeenNthCalledWith(2, expect.any(PrismaJob), AnyPrismaClient);
    });
    afterAll(() => {
      void queue.stop();
    });
  });

  describe("priority", () => {
    let queue: PrismaQueue<EmailJobPayload, EmailJobResult>;
    beforeAll(() => {
      queue = createEmailQueue();
    });
    beforeEach(async () => {
      await prisma.queueJob.deleteMany();
      // void queue.start();
    });
    afterEach(() => {
      void queue.stop();
    });
    it("should properly prioritize a job with a lower priority", async () => {
      // eslint-disable-next-line @typescript-eslint/require-await
      queue.worker = vi.fn(async (_job) => {
        return { code: "200" };
      });
      await queue.enqueue({ email: "foo@bar.com" });
      await queue.enqueue({ email: "baz@bar.com" }, { priority: -1 });
      void queue.start();
      await waitForNthJob(queue, 2);
      expect(queue.worker).toHaveBeenCalledTimes(2);
      expect(queue.worker).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          payload: { email: "baz@bar.com" },
        }),
        AnyPrismaClient,
      );
      expect(queue.worker).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          payload: { email: "foo@bar.com" },
        }),
        AnyPrismaClient,
      );
    });
    afterAll(() => {
      void queue.stop();
    });
  });

  describe("Job.progress()", () => {
    let queue: PrismaQueue<EmailJobPayload, EmailJobResult>;
    beforeAll(() => {
      queue = createEmailQueue();
    });
    beforeEach(async () => {
      await prisma.queueJob.deleteMany();
      void queue.start();
    });
    afterEach(() => {
      void queue.stop();
    });
    it("should properly update job progress", async () => {
      queue.worker = vi.fn(async (job: PrismaJob<EmailJobPayload, EmailJobResult>) => {
        debug("working...", job.id, job.payload);
        await job.progress(50);
        throw new Error("failed");
      });
      const job = await queue.enqueue({ email: "foo@bar.com" });
      void queue.start();
      await waitForNextJob(queue);
      const record = await job.fetch();
      expect(record.progress).toBe(50);
    });
    afterAll(() => {
      void queue.stop();
    });
  });

  describe("error events", () => {
    it("should emit jobError for worker failures", async () => {
      const queue = createEmailQueue({ pollInterval: 200 });
      await prisma.queueJob.deleteMany();
      const jobErrors: { error: unknown; jobId: bigint }[] = [];
      queue.on("jobError", (error, job) => {
        jobErrors.push({ error, jobId: job.id });
      });
      // eslint-disable-next-line @typescript-eslint/require-await
      queue.worker = vi.fn(async () => {
        throw new Error("worker failed");
      });
      const job = await queue.enqueue({ email: "error@test.com" });
      void queue.start();
      await waitForNextJob(queue);
      await queue.stop();
      expect(jobErrors.length).toBe(1);
      expect(jobErrors[0]?.jobId).toBe(job.id);
      expect(jobErrors[0]?.error).toBeInstanceOf(Error);
    });
    it("should not emit error event for worker failures", async () => {
      const queue = createEmailQueue({ pollInterval: 200 });
      await prisma.queueJob.deleteMany();
      const systemErrors: unknown[] = [];
      // Replace default error handler
      queue.removeAllListeners("error");
      queue.on("error", (error) => {
        systemErrors.push(error);
      });
      // eslint-disable-next-line @typescript-eslint/require-await
      queue.worker = vi.fn(async () => {
        throw new Error("job failure");
      });
      await queue.enqueue({ email: "test@test.com" });
      void queue.start();
      await waitForNextJob(queue);
      await queue.stop();
      expect(systemErrors.length).toBe(0);
    });
  });

  describe("Job.isLocked()", () => {
    let queue: PrismaQueue<EmailJobPayload, EmailJobResult>;
    beforeAll(() => {
      queue = createEmailQueue({ pollInterval: 200 });
    });
    beforeEach(async () => {
      await prisma.queueJob.deleteMany();
      void queue.start();
    });
    afterEach(() => {
      void queue.stop();
    });
    it("should be toggled", async () => {
      queue.worker = vi.fn(async (_job) => {
        await waitFor(2000);
        return { code: "200" };
      });
      const job = await queue.enqueue({ email: "foo@bar.com" });
      await waitFor(400);
      expect(await job.isLocked()).toBe(true);
      await waitForNextJob(queue);
      expect(await job.isLocked()).toBe(false);
    });
    afterAll(() => {
      void queue.stop();
    });
  });

  describe("polling behavior", () => {
    let queue: PrismaQueue<EmailJobPayload, EmailJobResult>;
    beforeAll(() => {
      queue = createEmailQueue({ pollInterval: 100, jobInterval: 10 });
    });
    beforeEach(async () => {
      await prisma.queueJob.deleteMany();
    });
    afterEach(() => {
      void queue.stop();
    });

    it("should not process more jobs than exist in queue", async () => {
      const jobsProcessed: bigint[] = [];
      queue.worker = vi.fn(async (job: EmailJob) => {
        jobsProcessed.push(job.id);
        await waitFor(50);
        return { code: "200" };
      });

      // Enqueue 3 jobs
      await Promise.all([
        queue.enqueue({ email: "job1@test.com" }),
        queue.enqueue({ email: "job2@test.com" }),
        queue.enqueue({ email: "job3@test.com" }),
      ]);

      void queue.start();
      await waitForNthJob(queue, 3);

      // Should process exactly 3 jobs, no more
      expect(queue.worker).toHaveBeenCalledTimes(3);
      expect(new Set(jobsProcessed).size).toBe(3); // All unique job IDs
    });

    it("should respect concurrency limits when processing burst of jobs", async () => {
      const concurrentQueue = createEmailQueue({ pollInterval: 100, jobInterval: 10, maxConcurrency: 2 });
      const processing: bigint[] = [];
      const completed: bigint[] = [];
      let maxConcurrent = 0;

      concurrentQueue.worker = vi.fn(async (job: EmailJob) => {
        processing.push(job.id);
        maxConcurrent = Math.max(maxConcurrent, processing.length);
        await waitFor(100);
        completed.push(job.id);
        processing.splice(processing.indexOf(job.id), 1);
        return { code: "200" };
      });

      // Enqueue 5 jobs
      await Promise.all([
        concurrentQueue.enqueue({ email: "job1@test.com" }),
        concurrentQueue.enqueue({ email: "job2@test.com" }),
        concurrentQueue.enqueue({ email: "job3@test.com" }),
        concurrentQueue.enqueue({ email: "job4@test.com" }),
        concurrentQueue.enqueue({ email: "job5@test.com" }),
      ]);

      void concurrentQueue.start();
      await waitForNthJob(concurrentQueue, 5);
      await concurrentQueue.stop();

      // Should never exceed maxConcurrency
      expect(maxConcurrent).toBeLessThanOrEqual(2);
      expect(concurrentQueue.worker).toHaveBeenCalledTimes(5);
    });

    it("should process jobs in priority order", async () => {
      const processedEmails: string[] = [];
      // eslint-disable-next-line @typescript-eslint/require-await
      queue.worker = vi.fn(async (job: EmailJob) => {
        processedEmails.push(job.payload.email);
        return { code: "200" };
      });

      // Enqueue jobs with different priorities
      await queue.enqueue({ email: "priority-0@test.com" }, { priority: 0 });
      await queue.enqueue({ email: "priority-high@test.com" }, { priority: -10 });
      await queue.enqueue({ email: "priority-low@test.com" }, { priority: 10 });

      void queue.start();
      await waitForNthJob(queue, 3);

      // Should process in priority order (lower priority value = higher priority)
      expect(processedEmails[0]).toBe("priority-high@test.com");
      expect(processedEmails[1]).toBe("priority-0@test.com");
      expect(processedEmails[2]).toBe("priority-low@test.com");
    });

    it("should continue polling after queue becomes empty", async () => {
      queue.worker = vi.fn(async (_job) => {
        await waitFor(50);
        return { code: "200" };
      });

      await queue.enqueue({ email: "first@test.com" });
      void queue.start();
      await waitForNextJob(queue);
      expect(queue.worker).toHaveBeenCalledTimes(1);

      // Queue is now empty, should continue polling
      await waitFor(150); // Wait more than pollInterval

      // Add another job - should be picked up
      await queue.enqueue({ email: "second@test.com" });
      await waitForNextJob(queue);
      expect(queue.worker).toHaveBeenCalledTimes(2);
    });

    it("should handle jobs added while processing", async () => {
      let firstJobProcessing = false;
      queue.worker = vi.fn(async (job: EmailJob) => {
        if (job.payload.email === "first@test.com") {
          firstJobProcessing = true;
          await waitFor(100);
          firstJobProcessing = false;
        }
        return { code: "200" };
      });

      await queue.enqueue({ email: "first@test.com" });
      void queue.start();

      // Wait for first job to start processing
      await waitFor(20);
      expect(firstJobProcessing).toBe(true);

      // Add second job while first is processing
      await queue.enqueue({ email: "second@test.com" });

      // Both should complete
      await waitForNthJob(queue, 2);
      expect(queue.worker).toHaveBeenCalledTimes(2);
    });

    afterAll(() => {
      void queue.stop();
    });
  });

  describe("stop behavior", () => {
    let queue: PrismaQueue<EmailJobPayload, EmailJobResult>;
    beforeAll(() => {
      queue = createEmailQueue({ pollInterval: 100, jobInterval: 10 });
    });
    beforeEach(async () => {
      await prisma.queueJob.deleteMany();
    });
    afterEach(async () => {
      await queue.stop();
    });

    it("should wait for in-flight jobs to complete before returning", async () => {
      let jobStarted = false;
      let jobFinished = false;

      queue.worker = vi.fn(async (_job) => {
        jobStarted = true;
        await waitFor(500); // Long-running job
        jobFinished = true;
        return { code: "200" };
      });

      await queue.enqueue({ email: "long-job@test.com" });
      void queue.start();

      // Wait for job to start
      await waitFor(150);
      expect(jobStarted).toBe(true);
      expect(jobFinished).toBe(false);

      // Stop should wait for the job to complete
      const stopPromise = queue.stop();

      // Job should still be running
      expect(jobFinished).toBe(false);

      // Wait for stop to complete
      await stopPromise;

      // Job should now be finished
      expect(jobFinished).toBe(true);
      expect(queue.worker).toHaveBeenCalledTimes(1);
    });

    it("should handle stopping with multiple concurrent jobs", async () => {
      const concurrentQueue = createEmailQueue({ pollInterval: 100, jobInterval: 10, maxConcurrency: 3 });
      const jobsStarted: number[] = [];
      const jobsFinished: number[] = [];

      concurrentQueue.worker = vi.fn(async (job: EmailJob) => {
        const jobNum = job.payload.email.includes("job1") ? 1 : job.payload.email.includes("job2") ? 2 : 3;
        jobsStarted.push(jobNum);
        await waitFor(300);
        jobsFinished.push(jobNum);
        return { code: "200" };
      });

      // Enqueue 3 jobs
      await Promise.all([
        concurrentQueue.enqueue({ email: "job1@test.com" }),
        concurrentQueue.enqueue({ email: "job2@test.com" }),
        concurrentQueue.enqueue({ email: "job3@test.com" }),
      ]);

      void concurrentQueue.start();

      // Wait for jobs to start
      await waitFor(150);
      expect(jobsStarted.length).toBeGreaterThan(0);

      // Stop should wait for all jobs
      await concurrentQueue.stop();

      // All started jobs should be finished
      expect(jobsFinished.length).toBe(jobsStarted.length);
      expect(jobsStarted.length).toBeGreaterThanOrEqual(1);
    });

    it("should respect custom timeout option", async () => {
      const slowQueue = createEmailQueue({ pollInterval: 100, jobInterval: 10 });

      slowQueue.worker = vi.fn(async (_job) => {
        await waitFor(5000); // 5 second job
        return { code: "200" };
      });

      await slowQueue.enqueue({ email: "slow@test.com" });
      void slowQueue.start();

      await waitFor(150); // Let job start

      // Use a short timeout (1 second)
      const startTime = Date.now();
      await slowQueue.stop({ timeout: 1000 });
      const stopDuration = Date.now() - startTime;

      // Should timeout around 1 second (give some margin)
      expect(stopDuration).toBeLessThan(1500);
      expect(stopDuration).toBeGreaterThan(900);
    }, 10000);

    it("should wait longer with increased timeout", async () => {
      const slowQueue = createEmailQueue({ pollInterval: 100, jobInterval: 10 });
      let jobCompleted = false;

      slowQueue.worker = vi.fn(async (_job) => {
        await waitFor(1500); // 1.5 second job
        jobCompleted = true;
        return { code: "200" };
      });

      await slowQueue.enqueue({ email: "medium@test.com" });
      void slowQueue.start();

      await waitFor(150); // Let job start

      // Use a longer timeout that should allow job to complete
      await slowQueue.stop({ timeout: 5000 });

      // Job should have completed
      expect(jobCompleted).toBe(true);
    }, 10000);

    afterAll(async () => {
      await queue.stop();
    });
  });
});

describe("PrismaQueue (transactional: false)", () => {
  describe("dequeue", () => {
    let queue: PrismaQueue<EmailJobPayload, EmailJobResult>;
    beforeAll(() => {
      queue = createEmailQueueNonTransactional();
    });
    beforeEach(async () => {
      await prisma.queueJob.deleteMany();
      void queue.start();
    });
    afterEach(() => {
      void queue.stop();
    });
    it("should properly dequeue a successful job", async () => {
      queue.worker = vi.fn(async (_job, _client) => {
        await waitFor(200);
        return { code: "200" };
      });
      const job = await queue.enqueue({ email: "foo@bar.com" });
      await waitForNextJob(queue);
      expect(queue.worker).toHaveBeenCalledTimes(1);
      const record = await job.fetch();
      expect(record.finishedAt).toBeInstanceOf(Date);
    });
    it("should properly dequeue a failed job", async () => {
      let error: Error | null = null;
      // eslint-disable-next-line @typescript-eslint/require-await
      queue.worker = vi.fn(async (_job) => {
        error = new Error("failed");
        throw error;
      });
      const job = await queue.enqueue({ email: "foo@bar.com" });
      await waitForNextJob(queue);
      expect(queue.worker).toHaveBeenCalledTimes(1);
      const record = await job.fetch();
      expect(record.finishedAt).toBeNull();
      expect(record.error).toEqual(serializeError(error));
    });
    it("should provide PrismaClient with $transaction to worker", async () => {
      let clientHasTransaction = false;
      // eslint-disable-next-line @typescript-eslint/require-await
      queue.worker = vi.fn(async (_job: EmailJob, client: PrismaClient) => {
        clientHasTransaction = typeof client.$transaction === "function";
        return { code: "200" };
      });
      await queue.enqueue({ email: "foo@bar.com" });
      await waitForNextJob(queue);
      expect(clientHasTransaction).toBe(true);
    });
    it("should reset processedAt on retry", async () => {
      const retryQueue = createEmailQueueNonTransactional({
        maxAttempts: 3,
        pollInterval: 200,
        retryStrategy: ({ attempts, maxAttempts }) => {
          if (maxAttempts !== null && attempts >= maxAttempts) return null;
          return 100 * attempts;
        },
      });
      await prisma.queueJob.deleteMany();
      // eslint-disable-next-line @typescript-eslint/require-await
      retryQueue.worker = vi.fn(async () => {
        throw new Error("always fails");
      });
      const job = await retryQueue.enqueue({ email: "retry@test.com" });
      void retryQueue.start();
      // Wait for first dequeue
      await waitForNextJob(retryQueue);
      // After first failure, processedAt should be reset
      const record = await job.fetch();
      expect(record.processedAt).toBeNull();
      expect(record.finishedAt).toBeNull();
      // Wait for remaining retries
      await waitForNthJob(retryQueue, 2);
      await retryQueue.stop();
      expect(retryQueue.worker).toHaveBeenCalledTimes(3);
      // After max attempts, job should be finished
      const finalRecord = await job.fetch();
      expect(finalRecord.finishedAt).toBeInstanceOf(Date);
    });
    it("should work with deleteOn: success", async () => {
      const deleteQueue = createEmailQueueNonTransactional({ deleteOn: "success" });
      await prisma.queueJob.deleteMany();
      // eslint-disable-next-line @typescript-eslint/require-await
      deleteQueue.worker = vi.fn(async () => {
        return { code: "200" };
      });
      const job = await deleteQueue.enqueue({ email: "foo@bar.com" });
      void deleteQueue.start();
      await waitForNextJob(deleteQueue);
      await deleteQueue.stop();
      const record = await job.fetch();
      expect(record).toBeNull();
    });
    it("should properly update job progress", async () => {
      queue.worker = vi.fn(async (job: EmailJob) => {
        await job.progress(50);
        throw new Error("failed");
      });
      const job = await queue.enqueue({ email: "foo@bar.com" });
      void queue.start();
      await waitForNextJob(queue);
      const record = await job.fetch();
      expect(record.progress).toBe(50);
    });
    it("should properly re-enqueue a recurring cron job", async () => {
      // eslint-disable-next-line @typescript-eslint/require-await
      queue.worker = vi.fn(async () => {
        return { code: "200" };
      });
      await queue.schedule(
        { key: "nt-email-schedule", cron: "5 5 * * *", runAt: new Date() },
        { email: "foo@bar.com" },
      );
      void queue.start();
      await waitForNextEvent(queue, "enqueue");
      const jobs = await prisma.queueJob.findMany({ where: { key: "nt-email-schedule" } });
      expect(jobs.length).toBe(2);
      const nextJob = jobs[1];
      expect(nextJob?.runAt.getHours()).toBe(5);
      expect(nextJob?.runAt.getMinutes()).toBe(5);
    });
    afterAll(() => {
      void queue.stop();
    });
  });

  describe("requeueStale", () => {
    const STALE_QUEUE_NAME = "stale-test-queue";
    it("should recover stuck jobs", async () => {
      const queue = createEmailQueueNonTransactional({ pollInterval: 200, name: STALE_QUEUE_NAME });
      await prisma.queueJob.deleteMany();
      // Simulate a stuck job: processedAt set, finishedAt null
      const staleDate = new Date(Date.now() - 60_000); // 60 seconds ago
      await prisma.queueJob.create({
        data: {
          queue: STALE_QUEUE_NAME,
          payload: { email: "stuck@test.com" },
          processedAt: staleDate,
          attempts: 1,
          runAt: staleDate,
        },
      });
      // Verify it's not available for dequeue
      const sizeBefore = await queue.size(true);
      expect(sizeBefore).toBe(0);
      // Requeue stale jobs older than 30s
      const count = await queue.requeueStale({ olderThanMs: 30_000 });
      expect(count).toBe(1);
      // Now it should be available
      const sizeAfter = await queue.size(true);
      expect(sizeAfter).toBe(1);
    });
    it("should not requeue recently claimed jobs", async () => {
      const queue = createEmailQueueNonTransactional({ pollInterval: 200, name: STALE_QUEUE_NAME });
      await prisma.queueJob.deleteMany();
      // Simulate a recently claimed job
      await prisma.queueJob.create({
        data: {
          queue: STALE_QUEUE_NAME,
          payload: { email: "recent@test.com" },
          processedAt: new Date(), // just now
          attempts: 1,
          runAt: new Date(),
        },
      });
      const count = await queue.requeueStale({ olderThanMs: 30_000 });
      expect(count).toBe(0);
    });
  });

  describe("rolling upgrade safety", () => {
    const UPGRADE_QUEUE_NAME = "upgrade-test-queue";
    it("should not pick up rows with non-null processedAt", async () => {
      const queue = createEmailQueueNonTransactional({ pollInterval: 100, name: UPGRADE_QUEUE_NAME });
      await prisma.queueJob.deleteMany();
      // eslint-disable-next-line @typescript-eslint/require-await
      queue.worker = vi.fn(async () => {
        return { code: "200" };
      });
      // Simulate an old in-flight row (from before the processedAt guard)
      await prisma.queueJob.create({
        data: {
          queue: UPGRADE_QUEUE_NAME,
          payload: { email: "old@test.com" },
          processedAt: new Date(Date.now() - 120_000),
          attempts: 1,
          runAt: new Date(Date.now() - 120_000),
        },
      });
      // Also add a normal job
      await queue.enqueue({ email: "new@test.com" });
      void queue.start();
      await waitForNextJob(queue);
      await queue.stop();
      // Only the new job should have been processed
      expect(queue.worker).toHaveBeenCalledTimes(1);
      expect(queue.worker).toHaveBeenCalledWith(
        expect.objectContaining({ payload: { email: "new@test.com" } }),
        expect.any(Object),
      );
      // The old stale row should still be there, untouched
      const staleJobs = await prisma.queueJob.findMany({
        where: { payload: { equals: { email: "old@test.com" } } },
      });
      expect(staleJobs.length).toBe(1);
      expect(staleJobs[0]?.finishedAt).toBeNull();
    });
  });
});
