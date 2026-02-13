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
- Written in [TypeScript](https://www.typescriptlang.org/) for static type checking with exported types along the library.
- Built by [tsup](https://tsup.egoist.dev) to provide both CommonJS and ESM packages.

## Install

```bash
npm install @mgcrea/prisma-queue --save
# or
pnpm add @mgcrea/prisma-queue
```

## Quickstart

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

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `prisma` | `PrismaClient` | `new PrismaClient()` | Prisma client instance |
| `name` | `string` | `"default"` | Queue name for partitioning jobs |
| `maxAttempts` | `number \| null` | `null` | Max retry attempts (`null` = unlimited) |
| `maxConcurrency` | `number` | `1` | Max concurrent jobs |
| `pollInterval` | `number` | `10000` | Polling interval in ms |
| `jobInterval` | `number` | `50` | Delay between job dispatches in ms |
| `tableName` | `string` | Auto-detected | Database table name (required in edge environments) |
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

const queue = createQueue(
  {
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
const queue = createQueue({ name: "email" }, async (job, client) => {
  for (const item of items) {
    if (job.signal.aborted) {
      throw new Error("Job cancelled");
    }
    await processItem(item);
  }
  return { status: "done" };
});
```

### Non-Transactional Mode

By default, the worker runs inside the dequeue transaction (exactly-once semantics). Set `transactional: false` to run the worker outside the transaction, giving it access to the full `PrismaClient` with `$transaction` support (at-least-once semantics):

```ts
import { createQueue, type JobWorkerWithClient } from "@mgcrea/prisma-queue";

const queue = createQueue<JobPayload, JobResult>(
  { name: "email", transactional: false },
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

### Edge Environments

When using this library in edge environments (Cloudflare Workers, Vercel Edge Functions, etc.) where Prisma's DMMF (Datamodel Meta Format) may not be available, you must provide the `tableName` option:

```ts
export const emailQueue = createQueue<JobPayload, JobResult>(
  {
    name: "email",
    tableName: "queue_jobs", // Required in edge environments
  },
  async (job, client) => {
    // ...
  },
);
```

The library will throw an error if DMMF is unavailable and no `tableName` is provided.

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

### Migrating from v1 to v2

**Worker receives transactional client**: The worker callback's second parameter is now the Prisma transactional client (`PrismaLightClient`) instead of the root `PrismaClient`. Operations like `$transaction`, `$connect`, `$disconnect`, `$on`, `$use`, or `$extends` are not available inside the worker — perform those outside the worker.

**`modelName` option removed**: The library now resolves the Prisma delegate once in the constructor. If you were passing `modelName`, remove it — the library only supports the `QueueJob` model. Use `tableName` to override the database table name if needed.

**Error events split**: The `error` event no longer includes a `job` parameter. Worker failures now emit `jobError` instead:

```ts
// v1
queue.on("error", (error, job?) => { /* both job and system errors */ });

// v2
queue.on("jobError", (error, job) => { /* job execution failures */ });
queue.on("error", (error) => { /* system/infrastructure errors */ });
```

**`retryStrategy` replaces hardcoded backoff**: The retry logic is now configurable. The default behavior is preserved, but if you were relying on the exact backoff timing, note that it's now driven by the `retryStrategy` option.

**`alignTimeZone` option removed**: This option was deprecated and has been removed.

**`transactionTimeout` option added**: Defaults to 30 minutes (was hardcoded at 24 hours). Configure via the `transactionTimeout` option in milliseconds.

**Edge environments require explicit `tableName`**: The library now throws if DMMF is unavailable and no `tableName` is provided (previously it guessed using `snake_case + "s"`).

**Database index reordered**: The index on `QueueJob` changed from `[queue, priority, runAt, finishedAt]` to `[queue, finishedAt, processedAt, priority, runAt]`. Run a Prisma migration to update the index after upgrading.

**Dequeue now filters on `processedAt IS NULL`**: The dequeue query now requires `processedAt` to be null. Existing in-flight or crashed jobs with non-null `processedAt` and null `finishedAt` will no longer be picked up. Run this migration during a drained-queue window:

```sql
UPDATE queue_jobs SET "processedAt" = NULL WHERE "finishedAt" IS NULL;
```

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
