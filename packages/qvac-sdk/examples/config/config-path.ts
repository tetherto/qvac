import { fileURLToPath } from "url";
import { dirname, join } from "path";

/**
 * Helper to get the config file path for examples.
 *
 * Note: This is Node.js-only (uses 'url' and 'path' modules).
 * For Bare runtime, place your config file in the project root and let the SDK auto-discover it.
 */
export function getConfigPath(importMetaUrl: string, configFileName: string) {
  const __filename = fileURLToPath(importMetaUrl);
  const __dirname = dirname(__filename);
  return join(__dirname, "config", configFileName);
}
