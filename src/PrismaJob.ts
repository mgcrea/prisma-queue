import {DatabaseJob, PrismaLightClient} from './types';

export type PrismaJobOptions<T, U> = {
  prisma: PrismaLightClient;
};

export class PrismaJob<T, U> {
  #prisma: PrismaLightClient;

  constructor(private record: DatabaseJob<T, U>, {prisma}: PrismaJobOptions<T, U>) {
    this.#prisma = prisma;
  }

  public get id() {
    return this.record.id;
  }
  public get priority() {
    return this.record.priority;
  }
  public get payload() {
    return this.record.payload;
  }

  public async progress(progress: number) {
    return await this.#prisma.queueJob.update({
      where: {id: this.id},
      data: {progress: Math.max(0, Math.min(100, progress))},
    });
  }

  public async fetch() {
    return await this.#prisma.queueJob.findUnique({
      where: {id: this.id},
    });
  }
}
