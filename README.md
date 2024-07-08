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

1. Append the [`QueueJob` model](./prisma/schema.prisma) to your `schema.prisma` file

1. Create your queue

```ts
type JobPayload = { email: string };
type JobResult = { status: number };

export const emailQueue = createQueue<JobPayload, JobResult>("email", async (job, client) => {
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
  const job = await emailQueue.add({ email: "foo@bar.com" });
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

## Troubleshooting

1. If you use an old version of Prisma ranging from 2.29.0 to 4.6.1 (included), you must first add `"interactiveTransactions"` to your `schema.prisma` client configuration:

```prisma
generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["interactiveTransactions"]
}
```

## Authors

- [Olivier Louvignes](https://github.com/mgcrea) <<olivier@mgcrea.io>>

## Credits

Inspired by

- [pg-queue](https://github.com/OrKoN/pg-queue) by
  [Alex Rudenko](https://github.com/OrKoN)

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
