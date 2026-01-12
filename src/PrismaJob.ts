import { Prisma } from "../prisma";
import type { DatabaseJob, ITXClient } from "./types";
// import { debug } from "./utils";

export type PrismaJobOptions = {
  tableName: string;
  client: ITXClient;
};

/**
 * Represents a job within a Prisma-managed queue.
 */
export class PrismaJob<Payload, Result> {
  #tableName: string;
  #client: ITXClient;
  #record: DatabaseJob<Payload, Result>;

  public readonly id;
  public readonly createdAt: Date = new Date();

  /**
   * Constructs a new PrismaJob instance with the provided job record and database access objects.
   * @param record - The initial database job record.
   * @param model - The Prisma delegate used for database operations related to the job.
   * @param client - The Prisma client for executing arbitrary queries.
   */
  constructor(record: DatabaseJob<Payload, Result>, { tableName, client }: PrismaJobOptions) {
    this.#tableName = tableName;
    this.#client = client;
    this.#record = record;
    this.id = record.id;
  }

  /**
   * Internal method to assign a new record to the job.
   * @param record - Optional new record to assign.
   */
  #assign(record?: DatabaseJob<Payload, Result>) {
    if (record) {
      this.#record = record;
    }
  }

  /**
   * Gets the current job record.
   */
  public get record(): DatabaseJob<Payload, Result> {
    return this.#record;
  }

  /**
   * Gets the job's unique key if any.
   */
  public get key() {
    return this.#record.key;
  }

  /**
   * Gets the job's queue name.
   */
  public get queue() {
    return this.#record.queue;
  }

  /**
   * Gets the CRON expression associated with the job for recurring scheduling.
   */
  public get cron() {
    return this.#record.cron;
  }

  /**
   * Gets the job's priority level.
   */
  public get priority() {
    return this.#record.priority;
  }

  /**
   * Gets the payload associated with the job.
   */
  public get payload() {
    return this.#record.payload;
  }

  /**
   * Gets the timestamp when the job was finished.
   */
  public get finishedAt() {
    return this.#record.finishedAt;
  }

  /**
   * Gets the error record if the job failed.
   */
  public get error() {
    return this.#record.error;
  }

  /**
   * Updates the job's progress percentage.
   * @param progress - The new progress percentage.
   */
  public async progress(progress: number): Promise<DatabaseJob<Payload, Result>> {
    return await this.update({ progress: Math.max(0, Math.min(100, progress)) });
  }

  /**
   * Fetches the latest job record from the database and updates the internal state.
   */
  public async fetch(): Promise<DatabaseJob<Payload, Result>> {
    const record = (await this.#client.queueJob.findUnique({
      where: { id: this.id },
    })) as DatabaseJob<Payload, Result>;
    this.#assign(record);
    return record;
  }

  /**
   * Updates the job record in the database with new data.
   * @param data - The new data to be merged with the existing job record.
   */
  public async update(data: Prisma.QueueJobUpdateInput): Promise<DatabaseJob<Payload, Result>> {
    const record = (await this.#client.queueJob.update({
      where: { id: this.id },
      data,
    })) as DatabaseJob<Payload, Result>;
    this.#assign(record);
    return record;
  }

  /**
   * Deletes the job from the database.
   */
  public async delete(): Promise<DatabaseJob<Payload, Result>> {
    const record = (await this.#client.queueJob.delete({
      where: { id: this.id },
    })) as DatabaseJob<Payload, Result>;
    return record;
  }

  /**
   * Checks if the job is currently locked by another transaction.
   * @returns {Promise<boolean>} True if the job is locked, false otherwise.
   */
  public async isLocked(): Promise<boolean> {
    try {
      // Attempt to select and lock the row with a timeout
      await this.#client.$executeRawUnsafe(
        `SELECT "id" FROM "public"."${this.#tableName}" WHERE "id" = $1 FOR UPDATE NOWAIT`,
        this.id,
      );

      // If we reach here, the row is not locked
      return false;
    } catch (error) {
      // Handle specific error types that indicate lock contention
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        // PostgreSQL's lock_not_available
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
        return (error.meta as any)?.driverAdapterError?.cause?.code === "55P03";
      }
      // Re-throw other unexpected errors
      throw error;
    }
  }
}
