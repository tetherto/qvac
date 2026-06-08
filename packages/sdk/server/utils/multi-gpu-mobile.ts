export const MULTI_GPU_KEYS = ["main-gpu", "split-mode", "tensor-split"] as const;
type MultiGpuKey = (typeof MULTI_GPU_KEYS)[number];

// Deletes any multi-GPU keys from `config` IN PLACE and returns the removed
// keys. Mutation is intentional: callers strip before the config reaches the
// model constructor. gpu_layers (single-GPU layer offload) is intentionally
// absent from MULTI_GPU_KEYS.
export function stripMultiGpuKeys(
  config: Record<string, unknown>,
): readonly MultiGpuKey[] {
  const stripped = MULTI_GPU_KEYS.filter((k) => k in config);
  stripped.forEach((k) => delete config[k]);
  return stripped;
}
