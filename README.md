# Prisma Queue

<!-- markdownlint-disable MD033 -->
<p align="center">
  <a href="https://www.npmjs.com/package/@mgcrea/prisma-queue">
    <img src="https://img.shields.io/npm/v/@mgcrea/prisma-queue.svg?style=for-the-badge" alt="npm version" />
  </a>
  <a href="https://www.npmjs.com/package/@mgcrea/prisma-queue">
    <img src="https://img.shields.io/npm/dt/@mgcrea/prisma-queue.svg?style=for-the-badge" alt="npm total downloads" />
  </a>
  <a href="https://www.npmjs.com/package/@mgcrea/prisma-queue">
    <img src="https://img.shields.io/npm/dm/@mgcrea/prisma-queue.svg?style=for-the-badge" alt="npm monthly downloads" />
  </a>
  <a href="https://www.npmjs.com/package/@mgcrea/prisma-queue">
    <img src="https://img.shields.io/npm/l/@mgcrea/prisma-queue.svg?style=for-the-badge" alt="npm license" />
  </a>
  <br />
  <a href="https://github.com/mgcrea/prisma-queue/actions/workflows/main.yml">
    <img src="https://img.shields.io/github/actions/workflow/status/mgcrea/prisma-queue/main.yml?style=for-the-badge&branch=master" alt="build status" />
  </a>
  <a href="https://depfu.com/github/mgcrea/prisma-queue">
    <img src="https://img.shields.io/depfu/dependencies/github/mgcrea/prisma-queue?style=for-the-badge" alt="dependencies status" />
  </a>
</p>
<!-- markdownlint-enable MD037 -->

## Features

Simple, reliable and efficient concurrent work queue for [Prisma](https://prisma.io) + [PostgreSQL](https://www.postgresql.org/)

- Leverages PostgreSQL [SKIP LOCKED](https://www.2ndquadrant.com/en/blog/what-is-select-skip-locked-for-in-postgresql-9-5/) feature to reliably dequeue jobs
- Supports [crontab](https://crontab.guru) syntax for complex scheduled jobs
- Written in [TypeScript](https://www.typescriptlang.org/) for static type checking with exported types along the library.
- Built by [tsup](https://tsup.egoist.dev) to provide both CommonJS and ESM packages.

## Install

```bash
npm install @mgcrea/prisma-queue --save
# or
pnpm add @mgcrea/prisma-queue
```

## Quickstart

1. If you use an old version of Prisma ranging from 2.29.0 to 4.6.1 (included), you must first add `"interactiveTransactions"` to your `schema.prisma` client configuration:

```prisma
generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["interactiveTransactions"]
}
```

1. Append the [`QueueJob` model](./prisma/schema.prisma) to your `schema.prisma` file

1. Create your queue

```ts
type JobPayload = { email: string };
type JobResult = { status: number };

export const emailQueue = createQueue<JobPayload, JobResult>({ name: "email" }, async (job, client) => {
  const { id, payload } = job;
  console.log(`Processing job#${id} with payload=${JSON.stringify(payload)})`);
  // await someAsyncMethod();
  await job.progress(50);
  const status = 200;
  if (Math.random() > 0.5) {
    throw new Error(`Failed for some unknown reason`);
  }
  console.log(`Finished job#${id} with status=${status}`);
  return { status };
});
```

- Queue a job

```ts
import { emailQueue } from "./emailQueue";

const main = async () => {
  const job = await emailQueue.enqueue({ email: "foo@bar.com" });
};

main();
```

- Schedule a recurring job

```ts
import { emailQueue } from "./emailQueue";

const main = async () => {
  const nextJob = await queue.schedule(
    { key: "email-schedule", cron: "5 5 * * *" },
    { email: "foo@bar.com" },
  );
};

main();
```

- Start queue processing (usually in another process)

```ts
import { emailQueue } from "./emailQueue";

const main = async () => {
  await queue.start();
};

main();
```

## Advanced usage

### Edge Environments

When using this library in edge environments (Cloudflare Workers, Vercel Edge Functions, etc.) where Prisma's DMMF (Datamodel Meta Format) may not be available, you should explicitly provide the `tableName` option:

```ts
export const emailQueue = createQueue<JobPayload, JobResult>(
  {
    name: "email",
    tableName: "queue_jobs", // Explicit table name for edge environments
  },
  async (job, client) => {
    // ...
  },
);
```

The library will throw an error if DMMF is unavailable and no `tableName` is provided. In edge environments, always provide `tableName` explicitly.

### Threading

You can easily spin of your workers in separate threads using [worker_threads](https://nodejs.org/api/worker_threads.html#worker-threads) (Node.js >= 12.17.0).

It enables you to fully leverage your CPU cores and isolate your main application queue from potential memory leaks or crashes.

```ts
import { JobPayload, JobResult, PrismaJob } from "@mgcrea/prisma-queue";
import { Worker } from "node:worker_threads";
import { ROOT_DIR } from "src/config/env";
import { log } from "src/config/log";

const WORKER_SCRIPT = `${ROOT_DIR}/dist/worker.js`;

export const processInWorker = async <P extends JobPayload, R extends JobResult>(
  job: PrismaJob<P, R>,
): Promise<R> =>
  new Promise((resolve, reject) => {
    const workerData = getJobWorkerData(job);

    log.debug(`Starting worker thread for job id=${job.id} in queue=${job.record.queue}`);
    try {
      const worker = new Worker(WORKER_SCRIPT, {
        workerData,
      });

      worker.on("message", resolve);
      worker.on("error", reject);
      worker.on("exit", (code) => {
        if (code !== 0) {
          reject(
            new Error(
              `Worker for job id=${job.id} in queue=${job.record.queue} stopped with exit code ${code}`,
            ),
          );
        }
      });
    } catch (error) {
      reject(error as Error);
    }
  });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type JobWorkerData<P extends JobPayload = any> = {
  id: bigint;
  payload: P;
  queue: string;
};

const getJobWorkerData = <P extends JobPayload, R extends JobResult>(job: PrismaJob<P, R>): JobWorkerData => {
  // Prepare the job data for structured cloning in worker thread
  return {
    id: job.id,
    payload: job.payload,
    queue: job.record.queue,
  };
};
```

- `worker.ts`

```ts
import { parentPort, workerData } from "node:worker_threads";
import { log } from "src/config/log";
import { workers } from "src/queue";
import { type JobWorkerData } from "src/utils/queue";
import { logMemoryUsage } from "./utils/system";

log.info(`Worker thread started with data=${JSON.stringify(workerData)}`);

const typedWorkerData = workerData as JobWorkerData;
const { queue } = typedWorkerData;
const workerName = queue.replace(/Queue$/, "Worker") as keyof typeof workers;

log.debug(`Importing worker ${workerName} for queue=${queue}`);
const jobWorker = workers[workerName];
// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
if (!jobWorker) {
  log.error(`No worker found for queue=${queue}`);
  process.exit(1);
}

log.info(`Running worker for queue=${queue}`);
const result = await jobWorker(typedWorkerData);
log.info(`Worker for queue=${queue} completed with result=${JSON.stringify(result)}`);
parentPort?.postMessage(result);
process.exit(0);
```

## Migration Guide

### Breaking Changes (v2)

- **Worker receives transactional client**: The worker callback's second parameter is now the Prisma transactional client (`PrismaLightClient`) instead of the root `PrismaClient`. Operations like `$transaction`, `$connect`, `$disconnect`, `$on`, `$use`, or `$extends` are not available inside the worker — perform those outside the worker.
- **`alignTimeZone` option removed**: This option was deprecated and has been removed. Timezone alignment is no longer needed.
- **`transactionTimeout` option added**: Defaults to 30 minutes (was hardcoded at 24 hours). Configure via the `transactionTimeout` option in milliseconds.
- **Edge environments require explicit `tableName`**: The library no longer guesses the table name when DMMF is unavailable. Provide the `tableName` option explicitly.

## Authors

- [Olivier Louvignes](https://github.com/mgcrea) <<olivier@mgcrea.io>>

## Credits

Inspired by

- [pg-queue](https://github.com/OrKoN/pg-queue) by

## License

```txt
The MIT License

Copyright (c) 2022 Olivier Louvignes <olivier@mgcrea.io>

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```
