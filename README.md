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
- Supports [crontab](https://crontab.guru) syntax for complex scheduled jobs, or a structured `interval` for fixed cadences (e.g. every 20 hours)
- Pluggable retry strategies with exponential backoff by default; jobs that exhaust `maxAttempts` are **dead-lettered** (retained + `dead` event)
- Automatic lease-based recovery of crashed/stuck jobs (no manual bookkeeping), plus optional per-job timeouts
- Cooperative worker cancellation via `AbortSignal`
- Loud-by-default `jobError` / `dead` / `error` events for clean observability, plus a `stats()` breakdown for monitoring
- Bulk `enqueueMany()` and a `purge()` retention helper
- Compatible with **Prisma 7.4+** and any Prisma driver adapter (e.g. `@prisma/adapter-pg`)
- Written in [TypeScript](https://www.typescriptlang.org/) for static type checking with exported types along the library.
- Built by [tsdown](https://tsdown.dev) to provide both CommonJS and ESM packages.

## Install

```bash
npm install @mgcrea/prisma-queue --save
# or
pnpm add @mgcrea/prisma-queue
```

### Peer dependencies

This library requires **Prisma 7.4+** (for the `partialIndexes` preview feature used by the dequeue index) with a driver adapter:

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

> **Note**: By default the `client` parameter in the worker is the full `PrismaClient` (at-least-once semantics, `$transaction` available) with full typed access to your Prisma models. Pass `transactional: true` to instead run the worker inside the dequeue transaction with a transaction-scoped client (exactly-once). TypeScript infers the client type from the `prisma` option you pass.

- Queue a job

```ts
import { emailQueue } from "./emailQueue";

const main = async () => {
  const job = await emailQueue.enqueue({ email: "foo@bar.com" });
};

main();
```

- Schedule a recurring job (cron or interval)

```ts
import { emailQueue } from "./emailQueue";

const main = async () => {
  // Cron expression — runs every day at 05:05
  await queue.schedule(
    { key: "email-schedule", cron: "5 5 * * *" },
    { email: "foo@bar.com" },
  );

  // Or a structured interval — runs every 20 hours after each completion
  await queue.schedule(
    { key: "email-sync", interval: { hours: 20 } },
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
| `maxAttempts` | `number \| null` | `5` | Max retry attempts before dead-lettering (`null` = unlimited) |
| `maxConcurrency` | `number` | `1` | Max concurrent jobs |
| `pollInterval` | `number` | `10000` | Polling interval in ms |
| `jobInterval` | `number` | `50` | Delay between job dispatches in ms |
| `tableName` | `string` | `"queue_jobs"` | Database table name (must match `@@map` in your schema) |
| `deleteOn` | `"success" \| "always" \| "never"` | `"never"` | When to delete completed jobs. `"success"` deletes successes (dead-letters retained); `"always"` also deletes dead-letters (opt out of DLQ); `"never"` keeps everything |
| `transactionTimeout` | `number` | `1800000` | Transaction timeout in ms (30 min), transactional mode only |
| `transactionWarningTimeout` | `number \| null` | `transactionTimeout / 2` | Warn if a transactional worker holds its transaction longer than this (ms); `0`/`null` disables |
| `retryStrategy` | `RetryStrategy` | Exponential backoff | Custom retry logic |
| `maxRetryDelay` | `number` | `2³¹-1` ms | Ceiling for the default retry backoff delay |
| `transactional` | `boolean` | `false` | Run worker inside the dequeue transaction (exactly-once); default is at-least-once |
| `staleTimeout` | `number \| null` | `21600000` | Lease (ms, 6h) after which a claimed-but-unfinished job is auto-reclaimed (non-transactional only); `0`/`null` disables |
| `jobTimeout` | `number \| null` | `null` | Per-job wall-clock timeout (ms, non-transactional only); aborts the job's `signal` and fails the attempt |

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

// Job execution failures (worker threw) — fires on every failed attempt
queue.on("jobError", (error, job) => {
  console.error(`Job ${job.id} failed:`, error);
});

// Permanent failure — fires once when a job is dead-lettered (attempts exhausted)
queue.on("dead", (error, job) => {
  console.error(`Job ${job.id} dead-lettered:`, error);
});

// System/infrastructure errors (poll failures, cron scheduling errors)
queue.on("error", (error) => {
  console.error("Queue system error:", error);
});
```

> By default, `jobError` and `error` log via `console.error` so failures are never silent. Attach your own listeners to route or quiet them.

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

### Dead-letter Queue & Monitoring

A job that exhausts `maxAttempts` (default **5**) is permanently **dead-lettered**: its `deadLetteredAt` is set, it stays in the table for inspection, and a one-shot `dead` event fires. The attempt cap is also enforced at **claim time**, so a worker that hard-crashes the runtime (OOM, `process.exit`, segfault) can't loop forever — once reclaimed past its budget it is dead-lettered without running again.

```ts
queue.on("dead", (error, job) => {
  alert(`Job ${job.id} dead-lettered after ${job.maxAttempts} attempts`, error);
});

// Monitor backlog and dead-letter depth (counts are mutually exclusive)
const { pending, scheduled, processing, completed, dead } = await queue.stats();

// Retention: prune old finished rows (dead-letters are retained unless you ask)
await queue.purge({ olderThanMs: 7 * 24 * 60 * 60 * 1000 }); // finished jobs older than 7 days
await queue.purge({ olderThanMs: 30 * 24 * 60 * 60 * 1000, deadLetteredOnly: true });
```

### Bulk Enqueue

For high-throughput producers, `enqueueMany()` inserts many plain jobs in a single `createMany` (one round-trip) instead of one transaction per job. Keyed/cron/interval scheduling is not supported on this path — use `enqueue()`/`schedule()` for those.

```ts
const count = await queue.enqueueMany(
  users.map((u) => ({ email: u.email })),
  { priority: 1 }, // shared maxAttempts / priority / runAt
);
```

### Per-job Timeout

In the default (non-transactional) mode, set `jobTimeout` to bound a job's wall-clock time. On timeout the job's `signal` is aborted (so a cooperative worker can stop) and the attempt fails — then retried or dead-lettered as usual. (Transactional mode is bounded by `transactionTimeout` instead.)

```ts
const queue = createQueue(
  { prisma, name: "imports", jobTimeout: 5 * 60 * 1000 }, // 5 min
  async (job) => {
    job.signal.addEventListener("abort", () => cleanup());
    await doWork({ signal: job.signal });
  },
);
```

### Recurring Jobs

`schedule()` accepts **either** a cron expression **or** a structured `interval` (not both). Both forms require a `key` so the queue can deduplicate and re-enqueue across runs.

**Cron** — parsed by [croner](https://github.com/Hexagon/croner). The next `runAt` is computed from the cron expression after each completion:

```ts
await queue.schedule(
  { key: "daily-report", cron: "0 6 * * *" },
  { recipient: "ops@example.com" },
);
```

**Interval** — a structured duration object. Accepts any combination of `seconds`, `minutes`, `hours`, `days`:

```ts
await queue.schedule(
  { key: "sync", interval: { hours: 20 } },
  { source: "upstream" },
);

await queue.schedule(
  { key: "heartbeat", interval: { minutes: 5, seconds: 30 } },
  { id: "node-1" },
);
```

By default, the next run for an interval job is scheduled as `finishedAt + interval` — drift-tolerant, so a slow run doesn't cause a backlog. Pass `repeatFrom: "runAt"` for a fixed wall-clock cadence (`previousRunAt + interval`) — the same drift-free behavior as cron:

```ts
// Drift-free: every run lands on a 20-hour boundary from the first runAt
await queue.schedule(
  { key: "sync", interval: { hours: 20 }, repeatFrom: "runAt" },
  { source: "upstream" },
);
```

| `repeatFrom`               | Next `runAt`               | Behavior                                                                   |
| -------------------------- | -------------------------- | -------------------------------------------------------------------------- |
| `"finishedAt"` _(default)_ | `finishedAt + interval`    | Drift-tolerant: long-running jobs don't pile up                            |
| `"runAt"`                  | `previousRunAt + interval` | Drift-free wall-clock cadence; long runs can produce overlapping schedules |

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

### Execution Modes

> **Migrating from v2**: v2 defaulted to `transactional: true` (exactly-once, worker inside the dequeue transaction). v3 flips the default to `transactional: false` (at-least-once) — the conventional job-queue behavior and the same as v1.x. To keep v2 behavior, pass `transactional: true` explicitly. Note that under `transactional: true` the worker receives a transaction-scoped client (no `$transaction`); under the new default it receives the full `PrismaClient`.

By **default** (`transactional: false`) the worker runs **outside** the dequeue transaction with access to the full `PrismaClient` (including `$transaction`). The job is claimed atomically, then the worker runs on its own — **at-least-once** semantics. This is the right mode for most jobs, and the only safe mode for long-running workers or workers that use a separate connection (e.g. `worker_threads` or external services), since those cannot use a transaction-scoped client.

```ts
import { createQueue } from "@mgcrea/prisma-queue";

const queue = createQueue<JobPayload, JobResult, typeof prisma>(
  { prisma, name: "email" }, // transactional: false is the default
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

**Trade-offs**: In the default (non-transactional) mode, a process crash between claiming and completing a job can leave it "stuck" (`processedAt` set, `finishedAt` null). The queue auto-reclaims such jobs after `staleTimeout`; you can also recover them manually with `requeueStale()`:

```ts
// Requeue jobs claimed more than 5 minutes ago that never completed
const count = await queue.requeueStale({ olderThanMs: 5 * 60 * 1000 });
```

Note: `isLocked()` returns `false` during worker execution in non-transactional mode since the row lock is released after claiming.

#### Transactional Mode (exactly-once)

Pass `transactional: true` to run the worker **inside** the dequeue transaction. The worker receives a transaction-scoped client and its work commits atomically with the job's completion — **exactly-once** semantics:

```ts
import { createQueue, type JobWorker } from "@mgcrea/prisma-queue";

const queue = createQueue<JobPayload, JobResult, typeof prisma>(
  { prisma, name: "email", transactional: true },
  async (job, client) => {
    // client is transaction-scoped — no $transaction, no separate connections
    await client.user.update({ where: { id: 1 }, data: { email: job.payload.email } });
    return { status: 200 };
  },
);
```

> **Warning**: Transactional mode holds a `FOR UPDATE SKIP LOCKED` row lock and the transaction open for the **entire** worker duration (up to `transactionTimeout`, default 30 min). Do **not** use it for long-running workers, or workers that do their real work on a separate connection (`worker_threads`, external services) — they cannot use the transaction-scoped client, yet the held transaction can hit `transactionTimeout` (or starve the connection pool) and roll back the claim, causing the job to be re-dequeued and re-run. As a guardrail, the queue logs a warning when a transactional worker holds its transaction longer than `transactionWarningTimeout` (default 50% of `transactionTimeout`). For these workloads use the default `transactional: false`.

### Threading

You can easily spin of your workers in separate threads using [worker_threads](https://nodejs.org/api/worker_threads.html#worker-threads) (Node.js >= 12.17.0).

It enables you to fully leverage your CPU cores and isolate your main application queue from potential memory leaks or crashes.

> **Important**: Threaded workers must use the default `transactional: false` mode. A transaction-scoped client cannot cross a thread boundary, so the work would run on a separate connection while the dequeue transaction sits open holding a row lock — risking a `transactionTimeout` rollback and a re-run loop. The default mode (at-least-once) is exactly what threaded workers want; pair it with idempotent workers and `requeueStale()`/`staleTimeout` for crash recovery.

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

### Migrating from v2.x to v3.0

> See **[MIGRATION.md](./MIGRATION.md)** for the full guide (schema SQL, semantics caveats, upgrade checklist, rollback).

v3.0 is a robustness-focused major. Breaking changes:

1. **Default execution mode is now `transactional: false`** (at-least-once) instead of v2's `true` (exactly-once). The worker now receives the **full `PrismaClient`** (with `$transaction`) and runs outside the dequeue transaction. To keep v2 behavior, pass `transactional: true` explicitly — but prefer the default and write **idempotent workers**, since a crash-then-reclaim can run a job more than once. See [Execution Modes](#execution-modes).
2. **`maxAttempts` now defaults to `5`** (was unlimited). A job that exhausts it is **dead-lettered** rather than retried forever. Pass `maxAttempts: null` to restore unlimited retries.
3. **`deleteOn` enum changed**: `"failure"` was removed; the values are now `"success" | "always" | "never"`. Dead-letters are retained by default (and under `"success"`); only `"always"` deletes them. Use `purge()` for explicit dead-letter cleanup.
4. **Schema: add the `deadLetteredAt` column** and (recommended) switch the dequeue index to the partial form. The shipped schema uses `@@index(..., where: raw("\"finishedAt\" IS NULL"))`, which needs the `partialIndexes` preview feature (Prisma 7.4+) in your `generator` block. Run `prisma db push` (or generate a migration) after updating.

```prisma
model QueueJob {
  // ...existing fields...
  deadLetteredAt DateTime?
}
```

Non-breaking additions you may want to adopt: automatic stale-job recovery (`staleTimeout`, on by default in non-transactional mode), `jobTimeout`, `stats()`, `enqueueMany()`, `purge()`, and the `dead` event.

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
