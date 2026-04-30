import type { CanonicalModelType } from "@/schemas";
import { getSDKConfig } from "@/server/bare/registry/config-registry";
import { getRuntimeContext } from "@/server/bare/registry/runtime-context-registry";
import { getServerLogger } from "@/logging";

export {
  CANONICAL_TO_ALIAS,
  MODEL_CONFIG_SCHEMAS,
  BUILTIN_DEVICE_PATTERNS,
  matchesPattern,
  findAllMatchingPatterns,
  getDefaultsFromPattern,
  resolveModelConfigWithContext,
} from "@/server/bare/registry/model-config-utils";

import {
  BUILTIN_DEVICE_PATTERNS,
  resolveModelConfigWithContext,
} from "@/server/bare/registry/model-config-utils";

const logger = getServerLogger();

export function resolveModelConfig<T>(
  modelType: CanonicalModelType,
  userInput: Record<string, unknown>,
): T {
  const ctx = getRuntimeContext();
  const userPatterns = getSDKConfig().deviceDefaults ?? [];

  return resolveModelConfigWithContext<T>(
    modelType,
    userInput,
    ctx,
    userPatterns,
    BUILTIN_DEVICE_PATTERNS,
    (log) => {
      if (log.appliedPatterns.length > 0) {
        logger.debug(
          `[device-defaults] ${modelType}: applied [${log.appliedPatterns.join(" → ")}]`,
        );
      }
    },
  );
}
