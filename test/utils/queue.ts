import { PrismaJob, PrismaQueue, PrismaQueueEvents, createQueue, type PrismaQueueOptions } from "src/index";
import type { JobWorker } from "src/types";
import { prisma } from "./client";

export type JobPayload = { email: string };
export type JobResult = { code: string };

export const DEFAULT_POLL_INTERVAL = 500;
let globalQueueIndex = 0;

export const createEmailQueue = (
  options: PrismaQueueOptions = {},
  worker: JobWorker<JobPayload, JobResult> = async (_job) => {
    return { code: "200" };
  },
) => {
  const {
    pollInterval = DEFAULT_POLL_INTERVAL,
    name = `default-${globalQueueIndex}`,
    ...otherOptions
  } = options;
  globalQueueIndex++;
  return createQueue<JobPayload, JobResult>(
    {
      prisma,
      name,
      pollInterval,
      ...otherOptions,
    },
    worker,
  );
};

export const waitForNextJob = (queue: PrismaQueue<JobPayload, JobResult>) =>
  waitForNextEvent(queue, "dequeue");

export const waitForNthJob = <T extends JobPayload, U extends JobResult>(
  queue: PrismaQueue<T, U>,
  nth: number,
) => waitForNthEvent(queue, "dequeue", nth);

export const waitForNextEvent = <T extends JobPayload, U extends JobResult>(
  queue: PrismaQueue<T, U>,
  eventName: keyof PrismaQueueEvents<T, U>,
) =>
  new Promise((resolve) => {
    const listener = (job: PrismaJob<T, U>) => {
      resolve(job);
    };
    queue.once(eventName, listener);
  });

export const waitForNthEvent = <T extends JobPayload, U extends JobResult>(
  queue: PrismaQueue<T, U>,
  eventName: keyof PrismaQueueEvents<T, U>,
  nth = 1,
) =>
  new Promise((resolve) => {
    let count = 0;
    const jobs: PrismaJob<T, U>[] = [];
    const listener = (job: PrismaJob<T, U>) => {
      count++;
      jobs.push(job);
      if (count === nth) {
        resolve(jobs);
        queue.removeListener(eventName, listener);
      }
    };
    queue.on(eventName, listener);
  });
