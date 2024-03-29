import type { Prisma } from "@prisma/client";
import type { DatabaseJob } from "./types";

export type PrismaJobOptions = {
  model: Prisma.QueueJobDelegate;
};

export class PrismaJob<T, U> {
  #model: Prisma.QueueJobDelegate;
  #record: DatabaseJob<T, U>;

  public readonly id;

  constructor(record: DatabaseJob<T, U>, { model }: PrismaJobOptions) {
    this.#model = model;
    this.#record = record;
    this.id = record["id"];
  }

  #assign(record?: DatabaseJob<T, U>) {
    if (record) {
      this.#record = record;
    }
  }

  public get record() {
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

  public async progress(progress: number) {
    return await this.update({ progress: Math.max(0, Math.min(100, progress)) });
  }

  public async fetch() {
    const record = (await this.#model.findUnique({
      where: { id: this.id },
    })) as DatabaseJob<T, U>;
    this.#assign(record);
    return record;
  }

  public async update(data: Prisma.QueueJobUpdateInput) {
    const record = (await this.#model.update({
      where: { id: this.id },
      data,
    })) as DatabaseJob<T, U>;
    this.#assign(record);
    return record;
  }

  public async delete() {
    const record = (await this.#model.delete({
      where: { id: this.id },
    })) as DatabaseJob<T, U>;
    return record;
  }
}
