import { PrismaPg } from "@prisma/adapter-pg";
import { env } from "prisma/config";
import { ClientOptions } from "src/types";

export const client = {
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
} satisfies ClientOptions;
