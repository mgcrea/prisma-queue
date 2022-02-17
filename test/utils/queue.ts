import {createQueue, PrismaQueue, PrismaJob} from 'src/index';
import {prisma} from './client';

export type JobPayload = {email: string};
export type JobResult = {code: string};

const pollInterval = 500;
export const createEmailQueue = () => createQueue<JobPayload, JobResult>({prisma, pollInterval});

export const waitForNextJob = (queue: PrismaQueue<JobPayload, JobResult>) =>
  new Promise((resolve) => {
    queue.once('dequeue', (job) => {
      resolve(job);
    });
  });

export const waitForNthJob = <T, U>(queue: PrismaQueue<T, U>, nth: number) =>
  new Promise((resolve) => {
    let count = 0;
    const jobs: PrismaJob<T, U>[] = [];
    const listener = (job: PrismaJob<T, U>) => {
      count++;
      jobs.push(job);
      if (count === nth) {
        resolve(jobs);
        queue.removeListener('dequeue', listener);
      }
    };
    queue.on('dequeue', listener);
  });
