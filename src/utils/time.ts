export class AbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AbortError";
  }
}

export const waitFor = async (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      resolve();
    }, ms);

    if (signal) {
      signal.addEventListener("abort", () => {
        clearTimeout(timeout);
        reject(new AbortError("Aborted"));
      });
    }
  });

export const calculateDelay = (attempts: number): number =>
  Math.min(1000 * Math.pow(2, Math.max(1, attempts)) + Math.random() * 100, Math.pow(2, 31) - 1);

export const getCurrentTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * Validates that a timezone string is safe to use in SQL.
 * PostgreSQL timezone names should only contain alphanumeric characters, underscores, slashes, plus, and minus.
 * @param timezone - The timezone string to validate
 * @returns true if the timezone is safe
 */
export const isValidTimeZone = (timezone: string): boolean => {
  // Allow only safe characters: alphanumeric, underscore, slash, plus, minus, and colon
  // This matches valid IANA timezone names like "America/New_York", "UTC", "GMT+8", etc.
  return /^[a-zA-Z0-9_/+:-]+$/.test(timezone) && timezone.length > 0 && timezone.length < 100;
};
