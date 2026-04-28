import type { QvacConfig } from "@/schemas";

export const DEFAULT_REGISTRY_STREAM_TIMEOUT_MS = 60_000;

export interface RegistryClientDownloadOptions {
  timeout: number;
  outputFile: string;
  maxRetries?: number;
  onProgress?: (progress: { downloaded: number; total: number }) => void;
  signal?: globalThis.AbortSignal;
}

/**
 * Build the options passed to @qvac/registry-client download methods from the
 * current SDK config. Pure helper (no bare-* imports) so the mapping can be
 * unit-tested without standing up a real registry client.
 */
export function buildRegistryClientOptions(params: {
  sdkConfig: Pick<QvacConfig, "registryStreamTimeoutMs" | "registryDownloadMaxRetries">;
  outputFile: string;
  onProgress?: ((progress: { downloaded: number; total: number }) => void) | undefined;
  signal?: globalThis.AbortSignal | undefined;
}): RegistryClientDownloadOptions {
  const { sdkConfig, outputFile, onProgress, signal } = params;
  const timeout = sdkConfig.registryStreamTimeoutMs
    ?? DEFAULT_REGISTRY_STREAM_TIMEOUT_MS;
  const maxRetries = sdkConfig.registryDownloadMaxRetries;

  return {
    timeout,
    outputFile,
    ...(maxRetries !== undefined && { maxRetries }),
    ...(onProgress && { onProgress }),
    ...(signal && { signal: signal as unknown as globalThis.AbortSignal }),
  };
}
