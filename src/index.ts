import { PrismaQueue, type PrismaQueueOptions } from "./PrismaQueue";
import type { JobPayload, JobResult, JobWorker } from "./types";

export * from "./PrismaJob";
export * from "./PrismaQueue";
export type * from "./types";

export { prepareForJson, restoreFromJson } from "./utils";

/**
 * Factory function to create a new PrismaQueue instance.
 * This function simplifies the instantiation of a PrismaQueue by wrapping it into a function call.
 *
 * @param options - The configuration options for the PrismaQueue. These options configure how the queue interacts with the database and controls job processing behavior.
 * @param worker - The worker function that will process each job. The worker function is called with each dequeued job and is responsible for executing the job's logic.
 *
 * @returns An instance of PrismaQueue configured with the provided options and worker.
 *
 * @template T - The type of the job payload. It extends JobPayload which can be further extended to include more specific data types as needed.
 * @template U - The type of the result expected from the worker function after processing a job. It extends JobResult which can be specialized based on the application's needs.
 *
 * @example
 * // Create a new queue for email sending jobs
 * const emailQueue = createQueue<EmailPayload, void>({
 *   name: 'emails',
 *   prisma: new PrismaClient(),
 *   pollInterval: 5000,
 * }, async (job) => {
 *   await sendEmail(job.payload);
 * });
 */
export const createQueue = <T extends JobPayload = JobPayload, U extends JobResult = JobResult>(
  options: PrismaQueueOptions,
  worker: JobWorker<T, U>,
) => {
  return new PrismaQueue<T, U>(options, worker);
};
