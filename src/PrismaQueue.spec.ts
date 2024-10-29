import { PrismaClient } from "@prisma/client";
import type { PrismaQueue } from "src/index";
import { PrismaJob } from "src/PrismaJob";
import { debug, serializeError, waitFor } from "src/utils";
import {
  createEmailQueue,
  DEFAULT_POLL_INTERVAL,
  prisma,
  waitForNextEvent,
  waitForNextJob,
  waitForNthJob,
  type JobPayload,
  type JobResult,
} from "test/utils";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
        "add",
        "options",
        "worker",
      ]
    `);
  });
  describe("enqueue", () => {
    let queue: PrismaQueue<JobPayload, JobResult>;
    beforeAll(async () => {
      queue = createEmailQueue();
    });
    beforeEach(async () => {
      await prisma.queueJob.deleteMany();
      queue.start();
    });
    afterEach(async () => {
      queue.stop();
    });
    it("should properly enqueue a job", async () => {
      const job = await queue.enqueue({ email: "foo@bar.com" });
      expect(job).toBeInstanceOf(PrismaJob);
      expect(Object.keys(job)).toMatchInlineSnapshot(`
        [
          "id",
        ]
      `);
      const record = await job.fetch();
      expect(record.key).toBeNull();
      expect(record?.payload).toEqual({ email: "foo@bar.com" });
      expect(record?.runAt).toBeInstanceOf(Date);
    });

    it("should properly enqueue a job with a custom key", async () => {
      const job = await queue.enqueue({ email: "foo@bar.com" }, { key: "custom-key" });
      expect(job).toBeInstanceOf(PrismaJob);
      expect(Object.keys(job)).toMatchInlineSnapshot(`
        [
          "id",
        ]
      `);
      const record = await job.fetch();
      expect(record?.payload).toEqual({ email: "foo@bar.com" });
      expect(record?.runAt).toBeInstanceOf(Date);
      expect(record.key).toBe("custom-key");
    });
  });

  describe("schedule", () => {
    let queue: PrismaQueue<JobPayload, JobResult>;
    beforeAll(async () => {
      queue = createEmailQueue();
    });
    beforeEach(async () => {
      await prisma.queueJob.deleteMany();
      queue.start();
    });
    afterEach(async () => {
      queue.stop();
    });
    it("should properly schedule a recurring job", async () => {
      const job = await queue.schedule(
        { key: "email-schedule", cron: "5 5 * * *" },
        { email: "foo@bar.com" },
      );
      expect(job).toBeInstanceOf(PrismaJob);
      const record = await job.fetch();
      expect(record).toBeDefined();
      expect(record?.runAt.getHours()).toBe(5);
      expect(record?.runAt.getMinutes()).toBe(5);
    });
    it("should properly re-enqueue a recurring job", async () => {
      await queue.schedule(
        { key: "email-schedule", cron: "5 5 * * *", runAt: new Date() },
        { email: "foo@bar.com" },
      );
      queue.start();
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
    let queue: PrismaQueue<JobPayload, JobResult>;
    beforeAll(async () => {
      queue = createEmailQueue();
    });
    beforeEach(async () => {
      await prisma.queueJob.deleteMany();
      queue.start();
    });
    afterEach(async () => {
      queue.stop();
    });
    it("should properly dequeue a successful job", async () => {
      queue.worker = vi.fn(async (_job) => {
        await waitFor(200);
        return { code: "200" };
      });
      const job = await queue.enqueue({ email: "foo@bar.com" });
      await waitForNextJob(queue);
      expect(queue.worker).toHaveBeenCalledTimes(1);
      expect(queue.worker).toHaveBeenNthCalledWith(1, expect.any(PrismaJob), expect.any(PrismaClient));
      const record = await job.fetch();
      expect(record?.finishedAt).toBeInstanceOf(Date);
    });
    it("should properly dequeue a failed job", async () => {
      let error: Error | null = null;
      queue.worker = vi.fn(async (_job) => {
        error = new Error("failed");
        throw error;
      });
      const job = await queue.enqueue({ email: "foo@bar.com" });
      await waitForNextJob(queue);
      expect(queue.worker).toHaveBeenCalledTimes(1);
      expect(queue.worker).toHaveBeenNthCalledWith(1, expect.any(PrismaJob), expect.any(PrismaClient));
      const record = await job.fetch();
      expect(record?.finishedAt).toBeNull();
      expect(record?.error).toEqual(serializeError(error));
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
      expect(queue.worker).toHaveBeenNthCalledWith(2, expect.any(PrismaJob), expect.any(PrismaClient));
    });
    it("should properly handle multiple restarts", async () => {
      const JOB_WAIT = 50;
      await queue.stop();
      queue.worker = vi.fn(async (_job) => {
        await waitFor(JOB_WAIT);
        return { code: "200" };
      });
      await Promise.all([
        queue.enqueue({ email: "foo1@bar1.com" }),
        queue.enqueue({ email: "foo2@bar2.com" }),
      ]);
      queue.start();
      expect(queue.worker).toHaveBeenCalledTimes(0);
      await queue.stop();
      queue.start();
      await waitFor(10);
      expect(queue.worker).toHaveBeenCalledTimes(1);
      await waitFor(JOB_WAIT + 10);
      expect(queue.worker).toHaveBeenCalledTimes(1);
    });
    afterAll(() => {
      queue.stop();
    });
  });

  describe("deleteOn", () => {
    let queue: PrismaQueue<JobPayload, JobResult>;
    describe("success", () => {
      beforeAll(async () => {
        queue = createEmailQueue({ deleteOn: "success" });
      });
      beforeEach(async () => {
        await prisma.queueJob.deleteMany();
        queue.start();
      });
      afterEach(async () => {
        queue.stop();
      });
      it("should properly dequeue a successful job", async () => {
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
        queue.stop();
      });
    });
    describe("failure", () => {
      beforeAll(async () => {
        queue = createEmailQueue({ deleteOn: "failure" });
      });
      beforeEach(async () => {
        await prisma.queueJob.deleteMany();
        queue.start();
      });
      afterEach(async () => {
        queue.stop();
      });
      it("should properly dequeue a failed job", async () => {
        let error: Error | null = null;
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
        queue.stop();
      });
    });
    describe("always", () => {
      beforeAll(async () => {
        queue = createEmailQueue({ deleteOn: "always" });
      });
      beforeEach(async () => {
        await prisma.queueJob.deleteMany();
        queue.start();
      });
      afterEach(async () => {
        queue.stop();
      });
      it("should properly dequeue a successful job", async () => {
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
        queue.stop();
      });
    });
  });

  describe("maxConcurrency", () => {
    let queue: PrismaQueue<JobPayload, JobResult>;
    beforeAll(async () => {
      queue = createEmailQueue({ maxConcurrency: 2 });
    });
    beforeEach(async () => {
      await prisma.queueJob.deleteMany();
      queue.start();
    });
    afterEach(async () => {
      queue.stop();
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
      expect(queue.worker).toHaveBeenNthCalledWith(2, expect.any(PrismaJob), expect.any(PrismaClient));
    });
    afterAll(() => {
      queue.stop();
    });
  });

  describe("priority", () => {
    let queue: PrismaQueue<JobPayload, JobResult>;
    beforeAll(async () => {
      queue = createEmailQueue();
    });
    beforeEach(async () => {
      await prisma.queueJob.deleteMany();
      // queue.start();
    });
    afterEach(async () => {
      queue.stop();
    });
    it("should properly prioritize a job with a lower priority", async () => {
      queue.worker = vi.fn(async (_job) => {
        return { code: "200" };
      });
      await queue.enqueue({ email: "foo@bar.com" });
      await queue.enqueue({ email: "baz@bar.com" }, { priority: -1 });
      queue.start();
      await waitForNthJob(queue, 2);
      expect(queue.worker).toHaveBeenCalledTimes(2);
      expect(queue.worker).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          payload: { email: "baz@bar.com" },
        }),
        expect.any(PrismaClient),
      );
      expect(queue.worker).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          payload: { email: "foo@bar.com" },
        }),
        expect.any(PrismaClient),
      );
    });
    afterAll(() => {
      queue.stop();
    });
  });

  describe("Job.progress()", () => {
    let queue: PrismaQueue<JobPayload, JobResult>;
    beforeAll(async () => {
      queue = createEmailQueue();
    });
    beforeEach(async () => {
      await prisma.queueJob.deleteMany();
      queue.start();
    });
    afterEach(async () => {
      queue.stop();
    });
    it("should properly update job progress", async () => {
      queue.worker = vi.fn(async (job) => {
        debug("working...", job.id, job.payload);
        await job.progress(50);
        throw new Error("failed");
      });
      const job = await queue.enqueue({ email: "foo@bar.com" });
      queue.start();
      await waitForNextJob(queue);
      const record = await job.fetch();
      expect(record?.progress).toBe(50);
    });
    afterAll(() => {
      queue.stop();
    });
  });

  describe("Job.isLocked()", () => {
    let queue: PrismaQueue<JobPayload, JobResult>;
    beforeAll(async () => {
      queue = createEmailQueue({ pollInterval: 200 });
    });
    beforeEach(async () => {
      await prisma.queueJob.deleteMany();
      queue.start();
    });
    afterEach(async () => {
      queue.stop();
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
      queue.stop();
    });
  });
});
