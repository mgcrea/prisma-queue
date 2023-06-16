import { PrismaJob, PrismaQueue, createQueue, type PrismaQueueOptions } from "src/index";
import type { JobWorker } from "src/types";
import { prisma } from "./client";

export type JobPayload = { email: string };
export type JobResult = { code: string };

const pollInterval = 500;
export const createEmailQueue = (
  options: PrismaQueueOptions = {},
  worker: JobWorker<JobPayload, JobResult> = async (_job) => {
    return { code: "200" };
  }
) => createQueue<JobPayload, JobResult>({ prisma, pollInterval, ...options }, worker);

export const waitForNextJob = (queue: PrismaQueue<JobPayload, JobResult>) =>
  waitForNextEvent(queue, "dequeue");

export const waitForNthJob = <T extends JobPayload, U extends JobResult>(
  queue: PrismaQueue<T, U>,
  nth: number
) => waitForNthEvent(queue, "dequeue", nth);

export const waitForNextEvent = (queue: PrismaQueue<JobPayload, JobResult>, eventName: string) =>
  new Promise((resolve) => {
    queue.once(eventName, (job) => {
      resolve(job);
    });
  });

export const waitForNthEvent = <T extends JobPayload, U extends JobResult>(
  queue: PrismaQueue<T, U>,
  eventName: string,
  nth = 1
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
