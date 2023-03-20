import { PrismaQueue, PrismaQueueOptions } from "./PrismaQueue";
import type { JobPayload, JobResult, JobWorker } from "./types";

export * from "./PrismaJob";
export * from "./PrismaQueue";

export const createQueue = <T extends JobPayload = JobPayload, U extends JobResult = JobResult>(
  options: PrismaQueueOptions,
  worker?: JobWorker<T, U>
) => {
  return new PrismaQueue<T, U>(options, worker);
};
