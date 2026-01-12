import { PrismaPg } from "@prisma/adapter-pg";
import type { ITXClientDenyList } from "@prisma/client/runtime/client";
import { Prisma, PrismaClient } from "../prisma";
import { QueueJobModel as PrismaQueueJob } from "../prisma/client/models";
import type { PrismaJob } from "./PrismaJob";

export type ITXClient = Omit<PrismaClient, ITXClientDenyList>;

export type Simplify<T> = { [KeyType in keyof T]: T[KeyType] } & {};

export type JobPayload = Prisma.InputJsonValue;
export type JobResult = Prisma.InputJsonValue;
export type DatabaseJob<Payload, Result> = Simplify<
  Omit<PrismaQueueJob, "payload" | "result"> & { payload: Payload; result: Result }
>;

export type JobCreator<T extends JobPayload> = (client: ITXClient) => Promise<T>;
export type JobWorker<T extends JobPayload = JobPayload, U extends JobResult = JobResult> = (
  job: PrismaJob<T, U>,
  client: ITXClient,
) => Promise<U>;

export type Adapter = PrismaPg;
export type Log = Prisma.PrismaClientOptions["log"];
