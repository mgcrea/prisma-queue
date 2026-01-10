import { Prisma, PrismaClient } from "../prisma";
import { QueueJobModel as PrismaQueueJob } from "../prisma/client/models";
import type { PrismaJob } from "./PrismaJob";

export type Simplify<T> = { [KeyType in keyof T]: T[KeyType] } & {};

export type JobPayload = Prisma.InputJsonValue;
export type JobResult = Prisma.InputJsonValue;
export type DatabaseJob<Payload, Result> = Simplify<
  Omit<PrismaQueueJob, "payload" | "result"> & { payload: Payload; result: Result }
>;

export type JobCreator<T extends JobPayload> = (client: PrismaLightClient) => Promise<T>;
export type JobWorker<T extends JobPayload = JobPayload, U extends JobResult = JobResult> = (
  job: PrismaJob<T, U>,
  client: PrismaClient,
) => Promise<U>;

export type PrismaLightClient = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;
