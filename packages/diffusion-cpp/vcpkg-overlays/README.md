# Fibo engine capability patch

The `stable-diffusion-cpp` overlay preserves registry port `2026-11-01#2`,
including its pinned source revision, checksum, features, and ggml dependency.
It adds `fibo-reference-images.patch` so `sd_ctx_uses_reference_images()` reports
Fibo's existing reference-editing capability. Without this fix, the addon routes
single Fibo inputs through SDEdit and rejects `init_images` before generation.

The package's `vcpkg-configuration.json` selects this overlay for source and CI
builds. Its source matches the registry port; the patch is part of vcpkg's build
cache identity. No registry publication or prebuilt package update is implied.

Once a registry release includes the capability fix, raise the manifest's native
dependency requirement to that release and remove this overlay and its config
entry together. Keep the Fibo integration tests as regression coverage.
