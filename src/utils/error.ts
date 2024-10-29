import { Prisma } from "@prisma/client";

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

export const isPrismaError = (error: unknown): error is Prisma.PrismaClientKnownRequestError => {
  return error instanceof Error && "code" in error;
};
