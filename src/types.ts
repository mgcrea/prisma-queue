import type { PrismaJob } from "./PrismaJob";

export type Simplify<T> = { [KeyType in keyof T]: T[KeyType] } & {};

// JSON types (replacing Prisma.InputJsonValue)
export type JsonValue = string | number | boolean | null | JsonObject | JsonArray;
export type JsonObject = { [key: string]: JsonValue };
export type JsonArray = JsonValue[];

// QueueJob record — mirrors the library's prisma schema
export type QueueJobRecord = {
  id: bigint;
  queue: string;
  key: string | null;
  cron: string | null;
  payload: JsonValue | null;
  result: JsonValue | null;
  error: JsonValue | null;
  progress: number;
  priority: number;
  attempts: number;
  maxAttempts: number | null;
  runAt: Date;
  notBefore: Date | null;
  finishedAt: Date | null;
  processedAt: Date | null;
  failedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

// Transaction client — preserves typed model access while removing tx-unsafe methods
type OmittedMethods = "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends";
export type TransactionClient<C> = Omit<C, OmittedMethods>;

export type JobPayload = JsonValue;
export type JobResult = JsonValue | void;
export type DatabaseJob<Payload, Result> = Simplify<
  Omit<QueueJobRecord, "payload" | "result"> & { payload: Payload; result: Result }
>;

export type JobCreator<T extends JobPayload, C = unknown> = (client: TransactionClient<C>) => Promise<T>;
export type JobWorker<T extends JobPayload = JobPayload, U extends JobResult = JobResult, C = unknown> = (
  job: PrismaJob<T, U>,
  client: TransactionClient<C>,
) => Promise<U>;

export type JobWorkerWithClient<
  T extends JobPayload = JobPayload,
  U extends JobResult = JobResult,
  C = unknown,
> = (job: PrismaJob<T, U>, client: C) => Promise<U>;

export type RetryContext = {
  attempts: number;
  maxAttempts: number | null;
  error: unknown;
};

export type RetryStrategy = (context: RetryContext) => number | null;
