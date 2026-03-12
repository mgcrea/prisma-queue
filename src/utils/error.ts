type PrismaKnownError = Error & { code: string; clientVersion: string; meta?: Record<string, unknown> };

export const serializeError = (err: unknown) => {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
    };
  }
  return {
    name: "UnknownError",
    message: String(err),
    stack: undefined,
  };
};

export const isPrismaError = (error: unknown): error is PrismaKnownError => {
  return error instanceof Error && "code" in error && "clientVersion" in error && "meta" in error;
};
