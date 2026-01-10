import { defineDmmfProperty } from "@prisma/client/runtime/client.js";
import { PrismaClient } from "../../prisma";

type RuntimeDataModel = Parameters<typeof defineDmmfProperty>[1];

/**
 * Converts a PascalCase model name to snake_case table name.
 * @example "QueueJob" -> "queue_job"
 */
const toSnakeCase = (str: string): string => {
  return str.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
};

/**
 * Gets the database table name for a Prisma model.
 * Falls back to snake_case conversion if DMMF is not available (e.g., edge environments).
 */
export const getTableName = (prisma: PrismaClient, modelName: string): string => {
  try {
    // @ts-expect-error from messing with prisma internals
    const datamodel = prisma._runtimeDataModel as RuntimeDataModel;
    const model = datamodel.models["QueueJob"];
    if (model?.dbName) {
      return model.dbName;
    }
  } catch {
    // DMMF not available (edge environment or separately generated Prisma client)
  }
  // Fallback to conventional snake_case table name
  return toSnakeCase(modelName);
};
