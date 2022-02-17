export const waitFor = async (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export const calculateDelay = (attempts: number): number =>
  Math.min(1000 * Math.pow(2, Math.max(1, attempts)) + Math.random() * 100, Math.pow(2, 31) - 1);
