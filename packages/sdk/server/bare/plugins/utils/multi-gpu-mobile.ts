export const MULTI_GPU_KEYS = ["main-gpu", "split-mode", "tensor-split"] as const;
type MultiGpuKey = (typeof MULTI_GPU_KEYS)[number];

// gpu_layers (single-GPU layer offload) is intentionally absent from MULTI_GPU_KEYS.
export function stripMultiGpuKeys(
  config: Record<string, unknown>,
): readonly MultiGpuKey[] {
  const stripped = MULTI_GPU_KEYS.filter((k) => k in config);
  stripped.forEach((k) => delete config[k]);
  return stripped;
}
