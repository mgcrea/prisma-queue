
export class AbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AbortError';
  }
}

export const waitFor = async (ms: number, signal: AbortSignal) =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      resolve(undefined);
    }, ms);

    signal.addEventListener('abort', () => {
      clearTimeout(timeout);
      reject(new AbortError('Aborted'));
    });
  });

export const calculateDelay = (attempts: number): number =>
  Math.min(1000 * Math.pow(2, Math.max(1, attempts)) + Math.random() * 100, Math.pow(2, 31) - 1);

export const getCurrentTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;
