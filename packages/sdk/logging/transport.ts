import type { LogTransport } from "./types";

export function safeTransport(
  transport: LogTransport,
  namespace: string,
): LogTransport {
  return (level, ns, message) => {
    try {
      const result = transport(level, ns, message);
      if (result instanceof Promise) {
        result.catch((error: unknown) => {
          console.error(`Transport error in ${namespace}:`, error); // fallback (avoid recursion)
        });
      }
    } catch (error: unknown) {
      console.error(`Transport error in ${namespace}:`, error); // fallback (avoid recursion)
    }
  };
}
