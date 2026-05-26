import type { IntervalDuration } from "../types";

export class AbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AbortError";
  }
}

export const waitFor = async (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortError("Aborted"));
      return;
    }

    const onAbort = () => {
      clearTimeout(timeout);
      reject(new AbortError("Aborted"));
    };

    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });

export const calculateDelay = (attempts: number): number =>
  Math.min(1000 * Math.pow(2, Math.max(1, attempts)) + Math.random() * 100, Math.pow(2, 31) - 1);

export const intervalToMs = (interval: IntervalDuration): number => {
  const { seconds = 0, minutes = 0, hours = 0, days = 0 } = interval;
  const ms = seconds * 1000 + minutes * 60_000 + hours * 3_600_000 + days * 86_400_000;
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error("interval must resolve to a positive duration");
  }
  return ms;
};
