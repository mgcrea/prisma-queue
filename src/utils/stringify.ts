import type { Prisma } from "@prisma/client";

type InputJsonValue = Prisma.InputJsonValue;
type InputJsonObject = Prisma.InputJsonObject;

export function prepareForJson<T>(originalValue: T): InputJsonValue {
  if (typeof originalValue === "undefined") {
    return {
      $type: "undefined",
    };
  } else if (typeof originalValue === "bigint") {
    return {
      $type: "bigint",
      $value: `0x${originalValue.toString(16)}`,
    };
  } else if (originalValue instanceof Map) {
    return {
      $type: "Map",
      $value: Array.from(originalValue.entries()),
    };
  } else if (originalValue instanceof Set) {
    return {
      $type: "Set",
      $value: Array.from(originalValue.values()),
    };
  } else if (originalValue instanceof Date) {
    return {
      $type: "Date",
      $value: originalValue.getTime(),
    };
  } else if (typeof originalValue === "object" && originalValue !== null) {
    if (Array.isArray(originalValue)) {
      return originalValue.map(prepareForJson);
    } else {
      const copy: Record<string, InputJsonValue> = {};
      for (const key in originalValue) {
        copy[key] = prepareForJson(originalValue[key]);
      }
      return copy;
    }
  }
  return originalValue as InputJsonValue;
}

export function restoreFromJson<T = unknown>(preparedValue: InputJsonValue): T {
  if (typeof preparedValue === "object" && preparedValue !== null && "$type" in preparedValue) {
    if (preparedValue["$type"] === "undefined") {
      return undefined as T;
    } else if (preparedValue["$type"] === "bigint") {
      return BigInt(preparedValue["$value"] as string) as T;
    } else if (preparedValue["$type"] === "Map") {
      return new Map(preparedValue["$value"] as Array<[unknown, unknown]>) as T;
    } else if (preparedValue["$type"] === "Set") {
      return new Set(preparedValue["$value"] as Array<unknown>) as T;
    } else if (preparedValue["$type"] === "Date") {
      return new Date(preparedValue["$value"] as number) as T;
    }
  } else if (typeof preparedValue === "object" && preparedValue !== null) {
    if (Array.isArray(preparedValue)) {
      return preparedValue.map(restoreFromJson) as T;
    } else {
      const copy: Record<string, unknown> = {};
      for (const key in preparedValue) {
        copy[key] = restoreFromJson((preparedValue as InputJsonObject)[key] as InputJsonValue) as T;
      }
      return copy as T;
    }
  }
  return preparedValue as T;
}
