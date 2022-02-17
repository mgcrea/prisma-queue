import {PrismaQueueOptions, PrismaQueue} from './PrismaQueue';
import {JobPayload, JobResult, JobWorker} from './types';

export * from './PrismaQueue';
export * from './PrismaJob';

export const createQueue = <T extends JobPayload = JobPayload, U extends JobResult = JobResult>(
  options: PrismaQueueOptions,
  worker?: JobWorker<T, U>
) => {
  return new PrismaQueue<T, U>(options, worker);
};
