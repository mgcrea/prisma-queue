import { PrismaPg } from "@prisma/adapter-pg";
import createDebug from "debug";

import { PrismaClient } from "../../prisma/client/client.js";

const debug = createDebug("prisma-query");

const adapter = new PrismaPg({ connectionString: process.env["DATABASE_URL"] });

export const prisma = new PrismaClient({
  adapter,
  log: [
    {
      emit: "event",
      level: "query",
    },
    {
      emit: "stdout",
      level: "error",
    },
    {
      emit: "stdout",
      level: "info",
    },
    {
      emit: "stdout",
      level: "warn",
    },
  ],
});

prisma.$on("query", (queryEvent) => {
  const { query, duration, params } = queryEvent;
  debug(`${query} with params=${params} (took ${duration}ms)`);
});
