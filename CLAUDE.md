# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is **@mgcrea/prisma-queue**, a job queue library for Prisma + PostgreSQL. It leverages PostgreSQL's `SKIP LOCKED` feature for reliable job dequeuing and supports crontab syntax for scheduled jobs.

## Commands

### Development
- `pnpm dev` - Run tests in watch mode with debug output
- `pnpm start` - Run tests with full debug output
- `pnpm spec` - Run all tests once
- `pnpm test` - Run full test suite (lint, prettify, typecheck, spec)

### Building & Type Checking
- `pnpm build` - Build the library with tsup (outputs both CJS and ESM)
- `pnpm typecheck` - Run TypeScript type checking

### Code Quality
- `pnpm lint` - Lint src/ and test/ directories
- `pnpm prettycheck` - Check formatting
- `pnpm prettify` - Format code

### Database
- `pnpm prepare` - Generate Prisma client (runs automatically after install)
- `pnpm reset` - Force reset database and regenerate Prisma client

### Testing
- `pnpm coverage` - Run tests with coverage report
- Tests use Vitest with `--pool=forks` for process isolation

## Architecture

### Core Classes

**PrismaQueue** (`src/PrismaQueue.ts`)
- Main queue class that manages job processing
- Key methods:
  - `start()` - Begin polling and processing jobs
  - `stop()` - Stop processing
  - `enqueue(payload, options)` / `add()` - Add jobs to queue
  - `schedule(options, payload)` - Schedule recurring jobs with cron
  - `size(onlyAvailable?)` - Count pending jobs
- Uses an event emitter pattern with events: `enqueue`, `dequeue`, `success`, `error`
- Implements concurrency control via `maxConcurrency` option
- Uses PostgreSQL `FOR UPDATE SKIP LOCKED` for reliable job locking (line 319 in PrismaQueue.ts)

**PrismaJob** (`src/PrismaJob.ts`)
- Represents an individual job instance
- Key methods:
  - `progress(percentage)` - Update job progress
  - `update(data)` - Update job record
  - `delete()` - Remove job from queue
  - `fetch()` - Refresh job state from database
  - `isLocked()` - Check if job is locked by another transaction

### Database Schema

The `QueueJob` model (in `prisma/schema.prisma`) stores:
- `queue` - Queue name for partitioning jobs
- `key` + `cron` - For scheduled/recurring jobs
- `payload` / `result` / `error` - Job data (JSON)
- `priority` / `attempts` / `maxAttempts` - Execution control
- `runAt` / `notBefore` / `finishedAt` / `processedAt` / `failedAt` - Timestamps

Unique constraint on `[key, runAt]` ensures scheduled jobs don't duplicate.

### Job Processing Flow

1. **Enqueue**: Jobs are inserted into the database via `enqueue()` or `schedule()`
2. **Poll**: Queue continuously polls for available jobs based on `pollInterval`
3. **Dequeue**: Uses a raw SQL query with `FOR UPDATE SKIP LOCKED` to atomically claim a job
4. **Execute**: Calls the user-provided worker function with the job and Prisma client
5. **Completion**: Updates job with result/error, handles retries with exponential backoff
6. **Cron**: If job has `cron` + `key`, schedules next occurrence automatically

### Utilities (`src/utils/`)

- `debug.ts` - Debug logging with `debug` package
- `error.ts` - Error serialization for JSON storage
- `prisma.ts` - Prisma helper utilities (table name resolution, escaping)
- `string.ts` - String manipulation (uncapitalize, escape)
- `time.ts` - Time utilities (delay calculation, timezone handling)
- `stringify.ts` - BigInt-safe JSON serialization (`prepareForJson`, `restoreFromJson`)

### Entry Point

`src/index.ts` exports:
- `createQueue<T, U>(options, worker)` - Factory function for creating queues
- All types from `types.ts`
- `PrismaQueue` and `PrismaJob` classes
- Utility functions `prepareForJson` and `restoreFromJson`

## Testing

Tests are located in:
- `src/PrismaQueue.spec.ts` - Main queue tests
- `src/index.spec.ts` - Integration tests
- `test/setup.ts` - Test setup and teardown
- `test/utils/` - Testing utilities (client, queue helpers, debug, timing)

Tests require a PostgreSQL database specified via `DATABASE_URL` environment variable.

## Known Issues / TODOs

The following improvements have been identified and should be addressed:

1. **Transaction consistency in `enqueue()` method** (src/PrismaQueue.ts:188-209)
   - Issue: When `key && runAt` is true, `this.model.deleteMany()` is called instead of using the transactional `client`
   - Impact: Mixes transaction and non-transaction contexts, could lead to race conditions
   - Fix: Use `client[queueJobKey].deleteMany()` instead of `this.model.deleteMany()`

2. **Worker should use transactional client** (src/PrismaQueue.ts:335)
   - Issue: Worker is called with `this.#prisma` instead of the transactional `client`
   - Impact: Worker's database operations aren't part of the same transaction as job updates
   - Fix: Pass `client` to the worker instead of `this.#prisma`
   - Note: This is a breaking change that requires updating the `JobWorker` type signature

3. **`runAt` condition may miss jobs** (src/PrismaQueue.ts:334)
   - Issue: SQL query uses `runAt < NOW()` (strict less than)
   - Impact: Jobs scheduled for exactly the current second may be missed
   - Fix: Change to `runAt <= NOW()` to include jobs scheduled for the current second