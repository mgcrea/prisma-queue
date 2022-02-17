import {PrismaClient} from '@prisma/client';
import createDebug from 'debug';

const debug = createDebug('prisma-query');

export const prisma = new PrismaClient({
  log: [
    {
      emit: 'event',
      level: 'query',
    },
    {
      emit: 'stdout',
      level: 'error',
    },
    {
      emit: 'stdout',
      level: 'info',
    },
    {
      emit: 'stdout',
      level: 'warn',
    },
  ],
});

prisma.$on('query', (queryEvent) => {
  const {query, duration, params} = queryEvent;
  debug(`${query} with params=${params} (took ${duration}ms)`);
});
