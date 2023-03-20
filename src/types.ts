import type { Prisma, PrismaClient, QueueJob as PrismaQueueJob } from "@prisma/client";
import type { PrismaJob } from "./PrismaJob";

export type JobPayload = Prisma.InputJsonValue;
export type JobResult = Prisma.InputJsonValue;
export type DatabaseJob<T, U> = Omit<PrismaQueueJob, "payload" | "result"> & { payload: T; result: U };

export type JobCreator<T extends JobPayload> = (client: PrismaLightClient) => Promise<T>;
export type JobWorker<T extends JobPayload = JobPayload, U extends JobResult = JobResult> = (
  job: PrismaJob<T, U>,
  client: PrismaClient
) => Promise<U>;

export type PrismaLightClient = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use"
>;
