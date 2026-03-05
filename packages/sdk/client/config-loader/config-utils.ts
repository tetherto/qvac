import { qvacConfigSchema, type QvacConfig } from "@/schemas";
import { ConfigValidationFailedError } from "@/utils/errors-client";

export type { QvacConfig };

export function validateConfig(config: unknown): QvacConfig {
  const result = qvacConfigSchema.safeParse(config);

  if (!result.success) {
    const errors = result.error.issues
      .map((e) => `${String(e.path.join("."))}:  ${e.message}`)
      .join(", ");
    throw new ConfigValidationFailedError(errors);
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
