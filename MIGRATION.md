# Migration Guide

## v2.x → v3.0

v3.0 is a **robustness-focused major release**. The headline change is that the queue is now safe to run in its default mode without any manual bookkeeping: crashed/stuck jobs are reclaimed automatically, poison jobs dead-letter instead of looping forever, and failures are visible by default.

This guide covers every breaking change, the required schema update, the behavioral shifts to be aware of, and the new capabilities worth adopting.

---

### At a glance

| Change | v2.x | v3.0 | Action required |
|---|---|---|---|
| Default execution mode | `transactional: true` (exactly-once) | `transactional: false` (at-least-once) | Make workers idempotent, or set `transactional: true` |
| `maxAttempts` default | `null` (unlimited) | `5` (then dead-letter) | Set `maxAttempts: null` to keep unlimited |
| `deleteOn` values | `"success" \| "failure" \| "always" \| "never"` | `"success" \| "always" \| "never"` | Replace `"failure"` usage |
| Default failure logging | silent (`debug` only) | `console.error` | Attach your own listeners to quiet/route |
| Worker client type (default) | transaction-scoped client | full `PrismaClient` | Usually a non-issue; see below |
| Schema | — | adds `deadLetteredAt`, partial index | Migrate the database |

Everything else (`enqueue`, `schedule`, `size`, `requeueStale`, events, retry strategy) is source-compatible.

---

### Step 1 — Update the database schema

Add the `deadLetteredAt` column and (recommended) switch the dequeue index to a partial index that only covers un-finished rows, so it stays small as the table grows.

**Prisma schema:**

```prisma
generator client {
  provider        = "prisma-client"
  output          = "./client"
  previewFeatures = ["partialIndexes"] // required for the partial @@index below (Prisma 7.4+)
}

model QueueJob {
  // ...existing fields...
  deadLetteredAt DateTime?

  @@unique([queue, key, runAt])
  // Replaces the v2 full index. Only indexes pending rows.
  @@index([queue, processedAt, priority, runAt], where: raw("\"finishedAt\" IS NULL"))
  @@map("queue_jobs")
}
```

Then apply it:

```bash
prisma generate
prisma db push   # or: prisma migrate dev --name prisma_queue_v3
```

**If you can't enable the `partialIndexes` preview feature**, keep the column change and create the partial index with raw SQL instead (and drop the old full index):

```sql
-- DateTime maps to timestamp(3) (without time zone) by default, matching the other columns
ALTER TABLE queue_jobs ADD COLUMN "deadLetteredAt" timestamp(3);

-- Drop the v2 full index, then create the partial one. Confirm the old name first with `\d queue_jobs`
-- (Prisma's default is queue_jobs_queue_finishedAt_processedAt_priority_runAt_idx).
DROP INDEX IF EXISTS queue_jobs_queue_finishedAt_processedAt_priority_runAt_idx;
CREATE INDEX queue_jobs_queue_processedAt_priority_runAt_idx
  ON queue_jobs (queue, "processedAt", priority, "runAt")
  WHERE "finishedAt" IS NULL;
```

The partial index is optional — the queue works with any index that covers the dequeue predicate — but it's strongly recommended for tables that retain finished/dead-lettered rows.

---

### Step 2 — Decide your execution mode (the big one)

v2 defaulted to **exactly-once** (`transactional: true`): the worker ran *inside* the dequeue transaction with a transaction-scoped client. v3 defaults to **at-least-once** (`transactional: false`): the job is claimed atomically, then the worker runs *outside* the transaction with the **full `PrismaClient`**.

This is the conventional job-queue default and is the only safe mode for long-running workers or workers that use a separate connection (`worker_threads`, external services). But it changes delivery semantics, so choose deliberately:

**Option A — adopt the new default (recommended).** Make your workers **idempotent**. Under at-least-once, a process crash between completing the work and recording the result (then a lease reclaim) can run a job more than once.

```ts
// v3 default — worker receives the full PrismaClient
const queue = createQueue(
  { prisma, name: "email" },
  async (job, client) => {
    // `client` is the full PrismaClient here (has `$transaction`)
    await sendEmailIdempotently(job.payload);
  },
);
```

**Option B — keep v2 exactly-once.** Pass `transactional: true` explicitly. Best for short, non-idempotent side effects.

```ts
const queue = createQueue(
  { prisma, name: "email", transactional: true }, // worker gets a transaction-scoped client
  async (job, tx) => {
    await tx.somethingTransactional(); // no `$transaction` on a tx-scoped client
  },
);
```

> **Type note:** `createQueue` overloads on `transactional`. With the new default the worker is typed `JobWorkerWithClient` (full client); with `transactional: true` it's `JobWorker` (transaction-scoped client). Most code compiles unchanged, but if you explicitly annotated the worker's `client` parameter you may need to adjust.

> **`isLocked()`** returns `false` during worker execution in the default mode, since the row lock is released right after claiming.

---

### Step 3 — `maxAttempts` and the dead-letter queue

`maxAttempts` now defaults to **5**. A job that exhausts its attempts is **dead-lettered**: `deadLetteredAt` is set, the row is retained for inspection, and a one-shot `dead` event fires. The cap is also enforced at **claim time**, so a worker that hard-crashes the runtime (OOM, `process.exit`) can no longer loop forever.

```ts
// Keep v2's unlimited-retry behavior:
const queue = createQueue({ prisma, name: "email", maxAttempts: null }, worker);

// Or handle dead-letters explicitly:
queue.on("dead", (error, job) => alert(`Job ${job.id} dead-lettered`, error));
```

If you previously relied on `retryStrategy` alone to stop retries, it still works — `maxAttempts` is just an additional, finite default.

---

### Step 4 — `deleteOn` enum change

`"failure"` was removed. Dead-letters are now retained by default so the DLQ is inspectable.

| v2 value | v3 equivalent |
|---|---|
| `"never"` (default) | `"never"` — unchanged |
| `"success"` | `"success"` — deletes successes, **retains** dead-letters |
| `"failure"` | **removed** — use `purge({ olderThanMs, deadLetteredOnly: true })` on a timer |
| `"always"` | `"always"` — deletes successes **and** dead-letters (explicit opt-out of retention) |

```ts
// v2: deleteOn: "failure"  ->  v3: keep dead-letters, prune them deliberately
await queue.purge({ olderThanMs: 30 * 24 * 60 * 60 * 1000, deadLetteredOnly: true });
```

---

### Step 5 — Failures are loud by default

The default `error` and `jobError` handlers now `console.error` instead of only emitting `debug` output, so failures are visible without `DEBUG` set. To route or silence them, attach your own listeners (they run alongside the defaults):

```ts
queue.on("jobError", (error, job) => myLogger.warn({ jobId: job.id, error }));
```

---

### New capabilities (opt-in, non-breaking)

Worth adopting after the upgrade:

- **Automatic stale-job recovery** — `staleTimeout` (default 6h, non-transactional only). The poll loop auto-reclaims claimed-but-unfinished jobs, so you no longer need to call `requeueStale()` on a timer. Set it above your longest job; `0`/`null` disables.
- **`jobTimeout`** — per-job wall-clock bound (non-transactional). On timeout the job's `signal` is aborted and the attempt fails.
- **`stats()`** — `{ pending, scheduled, processing, completed, dead }` for monitoring/alerting.
- **`enqueueMany(payloads, options?)`** — single-round-trip bulk insert for high-throughput producers.
- **`purge({ olderThanMs, deadLetteredOnly? })`** — retention helper for finished/dead-lettered rows.
- **`dead` event** — one-shot signal when a job is permanently dead-lettered.
- **`maxRetryDelay`** — caps the default exponential backoff.
- **Atomic cron/interval reschedule** — in transactional mode the next occurrence is enqueued inside the dequeue transaction, so a crash can't break the recurring chain.

---

### Upgrade checklist

- [ ] Add `deadLetteredAt` to your schema; apply the migration (`prisma db push` / `migrate`).
- [ ] (Recommended) switch to the partial dequeue index (`partialIndexes` preview feature or raw SQL).
- [ ] Decide execution mode: adopt the at-least-once default with **idempotent workers**, or set `transactional: true`.
- [ ] Set `maxAttempts: null` if you require unlimited retries; otherwise add a `dead` handler.
- [ ] Replace any `deleteOn: "failure"` with retention via `purge(...)`.
- [ ] Review default logging — attach `error`/`jobError` listeners if you need custom routing.
- [ ] (Optional) adopt `staleTimeout`, `jobTimeout`, `stats()`, `enqueueMany()`, `purge()`.

### Rollback

v3 only **adds** a nullable column and changes an index, so a v3 database remains compatible with v2.x code. To roll back the library, revert to your previous `transactional`/`maxAttempts`/`deleteOn` settings; the extra `deadLetteredAt` column is ignored by v2.

---

## v1.x → v2.0

See the [README migration section](./README.md#migrating-from-v1x-to-v20).
