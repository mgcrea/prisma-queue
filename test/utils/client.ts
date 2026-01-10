import { PrismaPg } from "@prisma/adapter-pg";
import createDebug from "debug";
import { env } from "prisma/config";
import { PrismaClient } from "../../prisma";

const debug = createDebug("prisma-query");

export const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env("DATABASE_URL") }),
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

// prisma.$use((params, next) => {

// })
