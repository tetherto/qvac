// The speech and music fitters take a layer count alone and read any positive
// value as "the GPU stack, with the fallbacks a real load applies". Their
// loaders express that intent two different ways.

/**
 * For loads where a layer count only applies once the GPU is switched on, and
 * for those that offer no layer count at all.
 */
export function gpuLayersFromGate(useGpu: boolean | undefined, layers?: number): number {
  if (useGpu !== true) return 0
  return layers === undefined || layers <= 0 ? 1 : layers
}

/**
 * For loads where an explicit layer count takes effect on its own and wins over
 * the boolean, which the schema requires to agree with it when both are set.
 */
export function gpuLayersFromCount(useGpu: boolean | undefined, layers?: number): number {
  if (layers !== undefined) return layers
  return useGpu === true ? 1 : 0
}
