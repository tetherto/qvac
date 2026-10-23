// The speech and music fitters take a layer count alone and read any positive
// value as "the GPU stack, with the fallbacks a real load applies".

/**
 * The layer count for a load where a count only applies once the GPU is
 * switched on, or that offers no count at all.
 */
export function gpuLayersFromGate(useGpu: boolean | undefined, layers?: number): number {
  if (useGpu !== true) return 0
  return layers === undefined || layers <= 0 ? 1 : layers
}
