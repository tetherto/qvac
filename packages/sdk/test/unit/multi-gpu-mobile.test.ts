// @ts-expect-error brittle has no type declarations
import test from "brittle";
import { stripMultiGpuKeys, MULTI_GPU_KEYS } from "@/server/utils/multi-gpu-mobile";

test("stripMultiGpuKeys: removes all three multi-GPU keys when present", (t) => {
  const config: Record<string, unknown> = {
    "main-gpu": "0",
    "split-mode": "layer",
    "tensor-split": "1,1",
    device: "gpu",
    gpu_layers: "99",
  };
  const stripped = stripMultiGpuKeys(config);
  t.alike([...stripped], [...MULTI_GPU_KEYS]);
  t.absent("main-gpu" in config);
  t.absent("split-mode" in config);
  t.absent("tensor-split" in config);
  t.ok("device" in config);
  t.ok("gpu_layers" in config, "gpu_layers (single-GPU offload) must be preserved");
});

test("stripMultiGpuKeys: returns empty array and mutates nothing when no multi-GPU keys", (t) => {
  const config: Record<string, unknown> = { device: "gpu", gpu_layers: "99" };
  const stripped = stripMultiGpuKeys(config);
  t.alike([...stripped], []);
  t.ok("device" in config);
  t.ok("gpu_layers" in config);
});

test("stripMultiGpuKeys: strips only the keys that are present", (t) => {
  const config: Record<string, unknown> = { "tensor-split": "1,1", device: "gpu" };
  const stripped = stripMultiGpuKeys(config);
  t.alike([...stripped], ["tensor-split"]);
  t.absent("tensor-split" in config);
  t.ok("device" in config);
  t.absent("main-gpu" in config);
  t.absent("split-mode" in config);
});
