import { Prisma } from "@prisma/client";

/**
 * Gets the database table name for a Prisma model.
 * Throws if DMMF is not available (e.g., edge environments) — provide `tableName` explicitly.
 */
export const getTableName = (modelName: string): string => {
  try {
    const model = Prisma.dmmf?.datamodel?.models?.find((model) => model.name === modelName);
    if (model?.dbName) {
      return model.dbName;
    }
  } catch {
    // DMMF not available (edge environment or separately generated Prisma client)
  }
  throw new Error(
    `[prisma-queue] Could not resolve table name for model "${modelName}" (DMMF not available). ` +
      `Please provide the "tableName" option explicitly.`,
  );
};
