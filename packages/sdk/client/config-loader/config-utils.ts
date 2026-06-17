import { qvacConfigSchema, type QvacConfig } from "@/schemas";
import { ConfigValidationFailedError } from "@/utils/errors-client";
import { formatZodError } from "@/utils/zod-error";

export type { QvacConfig };

export function validateConfig(config: unknown): QvacConfig {
  const result = qvacConfigSchema.safeParse(config);

  if (!result.success) {
    throw new ConfigValidationFailedError(formatZodError(result.error));
  }

  return result.data;
}

export function parseJsonConfig(content: string, filePath: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    throw new ConfigValidationFailedError(
      `Invalid JSON in config file: ${filePath}`,
    );
  }
}
