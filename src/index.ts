import { PrismaQueue, type PrismaQueueOptions } from "./PrismaQueue";
import type { JobPayload, JobResult, JobWorker, JobWorkerWithClient } from "./types";

export * from "./PrismaJob";
export * from "./PrismaQueue";
export type * from "./types";

export { prepareForJson, restoreFromJson } from "./utils";

/**
 * Factory function to create a new PrismaQueue instance.
 *
 * @param options - Configuration options for the queue.
 * @param worker - The worker function that processes each job.
 * @returns An instance of PrismaQueue configured with the provided options and worker.
 */
export function createQueue<T extends JobPayload = JobPayload, U extends JobResult = JobResult, C = unknown>(
  options: PrismaQueueOptions<C> & { transactional: false },
  worker: JobWorkerWithClient<T, U, C>,
): PrismaQueue<T, U, C>;
export function createQueue<T extends JobPayload = JobPayload, U extends JobResult = JobResult, C = unknown>(
  options: PrismaQueueOptions<C>,
  worker: JobWorker<T, U, C>,
): PrismaQueue<T, U, C>;
export function createQueue<T extends JobPayload = JobPayload, U extends JobResult = JobResult, C = unknown>(
  options: PrismaQueueOptions<C>,
  worker: JobWorker<T, U, C> | JobWorkerWithClient<T, U, C>,
) {
  return new PrismaQueue<T, U, C>(options, worker);
}
