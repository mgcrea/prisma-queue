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
- Pluggable retry strategies with exponential backoff by default
- Cooperative worker cancellation via `AbortSignal`
- Separate `jobError` / `error` events for clean observability
- Compatible with **Prisma 7+** and any Prisma driver adapter (e.g. `@prisma/adapter-pg`)
- Written in [TypeScript](https://www.typescriptlang.org/) for static type checking with exported types along the library.
- Built by [tsup](https://tsup.egoist.dev) to provide both CommonJS and ESM packages.

## Install

```bash
npm install @mgcrea/prisma-queue --save
# or
pnpm add @mgcrea/prisma-queue
```

### Peer dependencies

This library requires **Prisma 7+** with a driver adapter:

```bash
pnpm add @prisma/client @prisma/adapter-pg
```

## Quickstart

1. Append the [`QueueJob` model](./prisma/schema.prisma) to your `schema.prisma` file

1. Create your queue

```ts
import { createQueue } from "@mgcrea/prisma-queue";
import { prisma } from "./prisma"; // your PrismaClient instance

type JobPayload = { email: string };
type JobResult = { status: number };

export const emailQueue = createQueue<JobPayload, JobResult, typeof prisma>(
  { prisma, name: "email" },
  async (job, client) => {
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
  },
);
```

> **Note**: The `client` parameter in the worker is a transaction-scoped client (in the default transactional mode) with full typed access to your Prisma models. TypeScript infers the client type from the `prisma` option you pass.

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

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `prisma` | `PrismaClient` | **(required)** | Your Prisma client instance |
| `name` | `string` | `"default"` | Queue name for partitioning jobs |
| `maxAttempts` | `number \| null` | `null` | Max retry attempts (`null` = unlimited) |
| `maxConcurrency` | `number` | `1` | Max concurrent jobs |
| `pollInterval` | `number` | `10000` | Polling interval in ms |
| `jobInterval` | `number` | `50` | Delay between job dispatches in ms |
| `tableName` | `string` | `"queue_jobs"` | Database table name (must match `@@map` in your schema) |
| `deleteOn` | `"success" \| "failure" \| "always" \| "never"` | `"never"` | When to delete completed jobs |
| `transactionTimeout` | `number` | `1800000` | Transaction timeout in ms (30 min) |
| `retryStrategy` | `RetryStrategy` | Exponential backoff | Custom retry logic |
| `transactional` | `boolean` | `true` | Run worker inside the dequeue transaction |

### Events

The queue emits typed events:

```ts
queue.on("enqueue", (job) => {
  console.log(`Job ${job.id} enqueued`);
});

queue.on("dequeue", (job) => {
  console.log(`Job ${job.id} picked up for processing`);
});

queue.on("success", (result, job) => {
  console.log(`Job ${job.id} succeeded with`, result);
});

// Job execution failures (worker threw)
queue.on("jobError", (error, job) => {
  console.error(`Job ${job.id} failed:`, error);
});

// System/infrastructure errors (poll failures, cron scheduling errors)
queue.on("error", (error) => {
  console.error("Queue system error:", error);
});
```

### Custom Retry Strategy

By default, failed jobs are retried with exponential backoff (2^attempts seconds + jitter). You can provide a custom `retryStrategy`:

```ts
import { createQueue, type RetryContext } from "@mgcrea/prisma-queue";

const queue = createQueue<JobPayload, JobResult, typeof prisma>(
  {
    prisma,
    name: "email",
    maxAttempts: 5,
    retryStrategy: ({ attempts, maxAttempts, error }: RetryContext) => {
      // Return delay in ms, or null to stop retrying
      if (maxAttempts !== null && attempts >= maxAttempts) return null;
      // Linear backoff: 1s, 2s, 3s, ...
      return 1000 * attempts;
    },
  },
  async (job, client) => {
    // ...
  },
);
```

### Cooperative Worker Cancellation

Dequeued jobs expose an `AbortSignal` that is triggered when `queue.stop()` is called. Use it to cooperatively cancel long-running work:

```ts
const queue = createQueue<JobPayload, JobResult, typeof prisma>(
  { prisma, name: "email" },
  async (job, client) => {
    for (const item of items) {
      if (job.signal.aborted) {
        throw new Error("Job cancelled");
      }
      await processItem(item);
    }
    return { status: "done" };
  },
);
```

### Non-Transactional Mode

By default, the worker runs inside the dequeue transaction (exactly-once semantics). Set `transactional: false` to run the worker outside the transaction, giving it access to the full `PrismaClient` with `$transaction` support (at-least-once semantics):

```ts
import { createQueue, type JobWorkerWithClient } from "@mgcrea/prisma-queue";

const queue = createQueue<JobPayload, JobResult, typeof prisma>(
  { prisma, name: "email", transactional: false },
  async (job, client) => {
    // client is the full PrismaClient — $transaction is available
    await client.$transaction(async (tx) => {
      await tx.user.update({ where: { id: 1 }, data: { email: job.payload.email } });
      await tx.auditLog.create({ data: { action: "email_updated" } });
    });
    return { status: 200 };
  },
);
```

**Trade-offs**: In non-transactional mode, a process crash between claiming and completing a job can leave it "stuck" (`processedAt` set, `finishedAt` null). Use `requeueStale()` to recover:

```ts
// Requeue jobs claimed more than 5 minutes ago that never completed
const count = await queue.requeueStale({ olderThanMs: 5 * 60 * 1000 });
```

Note: `isLocked()` returns `false` during worker execution in non-transactional mode since the row lock is released after claiming.

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

### Migrating from v1.x to v2.0

v2.0 drops `@prisma/client` imports entirely, making the library compatible with **Prisma 7+** and its new `prisma-client` generator. This is a breaking release.

#### Breaking changes

**1. `prisma` option is now required**

The library no longer creates a default `PrismaClient`. You must pass your own instance:

```ts
// v1
const queue = createQueue({ name: "email" }, worker);

// v2
import { prisma } from "./prisma";
const queue = createQueue({ prisma, name: "email" }, worker);
```

**2. Third type parameter `C` for client type**

`createQueue` and `PrismaQueue` now accept a third generic `C` that represents your PrismaClient type. TypeScript infers `C` from the `prisma` option, but if you explicitly specify type parameters, you must include all three:

```ts
// v1
createQueue<MyPayload, MyResult>({ name: "email" }, worker);

// v2
createQueue<MyPayload, MyResult, typeof prisma>({ prisma, name: "email" }, worker);
```

**3. Peer dependency: Prisma 7+**

The peer dependency changed from `@prisma/client >=3 <7` to `@prisma/client >=7` plus `@prisma/adapter-pg >=7`. You need a Prisma driver adapter:

```bash
pnpm add @prisma/client @prisma/adapter-pg pg
```

And configure your PrismaClient with the adapter:

```ts
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./prisma/client/client.js";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
export const prisma = new PrismaClient({ adapter });
```

**4. `tableName` defaults to `"queue_jobs"`**

DMMF-based table name auto-detection has been removed. The default is now `"queue_jobs"` (matching the `@@map` in the documented schema). If you use a custom table name, pass it explicitly:

```ts
createQueue({ prisma, name: "email", tableName: "my_custom_table" }, worker);
```

**5. `PrismaLightClient` type removed**

The `PrismaLightClient` type has been replaced by `TransactionClient<C>`, which is computed from your actual PrismaClient type. If you referenced `PrismaLightClient` in your code, replace it with `TransactionClient<typeof prisma>`.

**6. `void` is now a valid `JobResult`**

Workers that don't return a value no longer need to return `null`. `void` is accepted as a result type:

```ts
type ScanResult = void;
createQueue<ScanPayload, ScanResult, typeof prisma>({ prisma, name: "scan" }, async (job, client) => {
  // no return needed
});
```

#### No schema changes required

The database schema, table structure, and indexes are unchanged from v1.x. No migration is needed for your database.

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
