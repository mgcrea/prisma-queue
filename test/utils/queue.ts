import { PrismaJob, PrismaQueue, PrismaQueueEvents, createQueue, type PrismaQueueOptions } from "src/index";
import type { JobPayload, JobResult, JobWorker, JobWorkerWithClient } from "src/types";
import { prisma } from "./client";

type Client = typeof prisma;

export type EmailJobPayload = { email: string };
export type EmailJobResult = { code: string };
export type EmailJob = PrismaJob<EmailJobPayload, EmailJobResult>;

export const DEFAULT_POLL_INTERVAL = 500;
let globalQueueIndex = 0;

export const createEmailQueue = (
  options: Omit<PrismaQueueOptions<Client>, "prisma"> = {},
  worker: JobWorker<EmailJobPayload, EmailJobResult, Client> = async (_job) => {
    return { code: "200" };
  },
) => {
  const {
    pollInterval = DEFAULT_POLL_INTERVAL,
    name = `default-${globalQueueIndex}`,
    ...otherOptions
  } = options;
  globalQueueIndex++;
  return createQueue<EmailJobPayload, EmailJobResult, Client>(
    {
      prisma,
      name,
      pollInterval,
      ...otherOptions,
    },
    worker,
  );
};

export const createEmailQueueNonTransactional = (
  options: Omit<PrismaQueueOptions<Client>, "prisma" | "transactional"> = {},
  worker: JobWorkerWithClient<EmailJobPayload, EmailJobResult, Client> = async (_job, _client) => {
    return { code: "200" };
  },
) => {
  const {
    pollInterval = DEFAULT_POLL_INTERVAL,
    name = `default-${globalQueueIndex}`,
    ...otherOptions
  } = options;
  globalQueueIndex++;
  return createQueue<EmailJobPayload, EmailJobResult, Client>(
    {
      prisma,
      name,
      pollInterval,
      transactional: false,
      ...otherOptions,
    },
    worker,
  );
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const waitForNextJob = <T extends JobPayload, U extends JobResult>(queue: PrismaQueue<T, U, any>) =>
  waitForNextEvent(queue, "dequeue");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const waitForNthJob = <T extends JobPayload, U extends JobResult>(
  queue: PrismaQueue<T, U, any>,
  nth: number,
) => waitForNthEvent(queue, "dequeue", nth);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const waitForNextEvent = <T extends JobPayload, U extends JobResult>(
  queue: PrismaQueue<T, U, any>,
  eventName: keyof PrismaQueueEvents<T, U>,
) =>
  new Promise((resolve) => {
    const listener = (job: PrismaJob<T, U>) => {
      resolve(job);
    };
    queue.once(eventName, listener);
  });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const waitForNthEvent = <T extends JobPayload, U extends JobResult>(
  queue: PrismaQueue<T, U, any>,
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
