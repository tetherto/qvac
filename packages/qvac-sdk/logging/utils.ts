import { LEVEL_PRIORITIES } from "@qvac/logging/constants";
import type { LogLevel } from "@qvac/logging";
import stringify from "fast-safe-stringify";

export function isLevelEnabled(messageLevel: LogLevel, currentLevel: LogLevel) {
  const messagePriority = LEVEL_PRIORITIES[messageLevel];
  const currentPriority = LEVEL_PRIORITIES[currentLevel];

  if (messagePriority === undefined || currentPriority === undefined) {
    return false;
  }

  return messagePriority <= currentPriority;
}

export function formatArg(arg: unknown) {
  // Primitives
  if (
    arg === null ||
    arg === undefined ||
    typeof arg === "string" ||
    typeof arg === "number" ||
    typeof arg === "boolean" ||
    typeof arg === "symbol"
  ) {
    return String(arg);
  }

  // Functions - avoid printing source code
  if (typeof arg === "function") {
    return "[function]";
  }

  // Errors - preserve message and stack
  if (arg instanceof Error) {
    return `${arg.name || "Error"}: ${arg.message}${
      arg.stack ? `\n${arg.stack}` : ""
    }`;
  }

  // All other objects with a custom replacer
  try {
    const replacer = (_key: string, value: unknown): unknown => {
      if (value instanceof Set) return Array.from(value) as unknown[];
      if (value instanceof Map)
        return Object.fromEntries(value) as Record<string, unknown>;
      if (value instanceof RegExp) return String(value);
      if (typeof value === "bigint") return value.toString();
      return value;
    };

    return stringify(arg, replacer);
  } catch {
    return "[object]";
  }
}
