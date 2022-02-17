import {Prisma} from '@prisma/client';
import assert from 'assert';

export const getTableName = (modelName: string): string => {
  const model = Prisma.dmmf.datamodel.models.find((model) => model.name === modelName);
  assert(model && model.dbName, `Did not foudn model=${modelName} in Prisma.dmmf!`);
  return model.dbName;
};
