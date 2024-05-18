import type { Prisma } from "@prisma/client";
import type { DatabaseJob, PrismaLightClient } from "./types";
import { isPrismaError } from "./utils";
// import { debug } from "./utils";

export type PrismaJobOptions = {
  model: Prisma.QueueJobDelegate;
  client: PrismaLightClient;
};

export class PrismaJob<T, U> {
  #model: Prisma.QueueJobDelegate;
  #client: PrismaLightClient;
  #record: DatabaseJob<T, U>;

  public readonly id;

  constructor(record: DatabaseJob<T, U>, { model, client }: PrismaJobOptions) {
    this.#model = model;
    this.#client = client;
    this.#record = record;
    this.id = record["id"];
  }

  #assign(record?: DatabaseJob<T, U>) {
    if (record) {
      this.#record = record;
    }
  }

  public get record(): DatabaseJob<T, U> {
    return this.#record;
  }
  public get key() {
    return this.#record.key;
  }
  public get cron() {
    return this.#record.cron;
  }
  public get priority() {
    return this.#record.priority;
  }
  public get payload() {
    return this.#record.payload;
  }
  public get finishedAt() {
    return this.#record.finishedAt;
  }
  public get error() {
    return this.#record.error;
  }

  public async progress(progress: number): Promise<DatabaseJob<T, U>> {
    return await this.update({ progress: Math.max(0, Math.min(100, progress)) });
  }

  public async fetch(): Promise<DatabaseJob<T, U>> {
    const record = (await this.#model.findUnique({
      where: { id: this.id },
    })) as DatabaseJob<T, U>;
    this.#assign(record);
    return record;
  }

  public async update(data: Prisma.QueueJobUpdateInput): Promise<DatabaseJob<T, U>> {
    const record = (await this.#model.update({
      where: { id: this.id },
      data,
    })) as DatabaseJob<T, U>;
    this.#assign(record);
    return record;
  }

  public async delete(): Promise<DatabaseJob<T, U>> {
    const record = (await this.#model.delete({
      where: { id: this.id },
    })) as DatabaseJob<T, U>;
    return record;
  }

  public async isLocked(): Promise<boolean> {
    try {
      // Attempt to select and lock the row with a timeout
      await this.#client.$executeRawUnsafe(
        `SELECT "id" FROM "public"."queue_jobs" WHERE "id" = $1 FOR UPDATE NOWAIT`,
        this.id,
      );

      // If we reach here, the row is not locked
      return false;
    } catch (error) {
      // Handle specific error types that indicate lock contention
      if (isPrismaError(error) && error.meta?.["code"] === "55P03") {
        // PostgreSQL's lock_not_available
        return true;
      }
      // Re-throw other unexpected errors
      throw error;
    }
  }
}
