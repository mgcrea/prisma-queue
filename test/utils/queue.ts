import { PrismaPg } from "@prisma/adapter-pg";
import { env } from "prisma/config";
import { PrismaJob, PrismaQueue, PrismaQueueEvents, createQueue, type PrismaQueueOptions } from "src/index";
import type { JobPayload, JobResult, JobWorker } from "src/types";

export type EmailJobPayload = { email: string };
export type EmailJobResult = { code: string };
export type EmailJob = PrismaJob<EmailJobPayload, EmailJobResult>;

export const DEFAULT_POLL_INTERVAL = 500;
let globalQueueIndex = 0;

const adapter = new PrismaPg({ connectionString: env("DATABASE_URL") });

export const createEmailQueue = (
  options: Omit<PrismaQueueOptions, "adapter" | "log"> = {},
  // eslint-disable-next-line @typescript-eslint/require-await
  worker: JobWorker<EmailJobPayload, EmailJobResult> = async (_job) => {
    return { code: "200" };
  },
) => {
  const {
    pollInterval = DEFAULT_POLL_INTERVAL,
    name = `default-${globalQueueIndex}`,
    ...otherOptions
  } = options;
  globalQueueIndex++;
  return createQueue<EmailJobPayload, EmailJobResult>(
    {
      adapter,
      log: [
        {
          emit: "event",
          level: "query",
        },
        {
          emit: "stdout",
          level: "error",
        },
        {
          emit: "stdout",
          level: "info",
        },
        {
          emit: "stdout",
          level: "warn",
        },
      ],
      name,
      pollInterval,
      ...otherOptions,
    },
    worker,
  );
};

export const waitForNextJob = <T extends JobPayload, U extends JobResult>(queue: PrismaQueue<T, U>) =>
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
