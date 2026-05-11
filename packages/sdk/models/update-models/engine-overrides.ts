import { ModelType, type CanonicalModelType } from "../../schemas/model-types";

/**
 * Per-filename SDK engine overrides for the registry regenerator.
 *
 * The upstream registry's `engine` field identifies the addon package
 * (e.g. `@qvac/diffusion-cpp`). The SDK's `engine` field identifies the
 * plugin / model type (e.g. `sdcpp-generation` vs `sdcpp-upscaling`).
 * These coincide when an addon hosts exactly one SDK model type, but
 * `@qvac/diffusion-cpp` hosts both image generation and image upscaling,
 * so the upstream engine alone can't disambiguate them.
 *
 * Entries here are keyed by upstream filename (the last segment of the
 * registry path). The regenerator consults this map after resolving
 * the canonical engine: a match overrides the default mapping, a miss
 * falls through to the engine-based resolution.
 */
export const ENGINE_OVERRIDES_BY_FILENAME: Readonly<
  Record<string, CanonicalModelType>
> = {
  "RealESRGAN_x4plus.pth": ModelType.sdcppUpscaling,
  "RealESRGAN_x4plus_anime_6B.pth": ModelType.sdcppUpscaling,
  "RealESRNet_x4plus.pth": ModelType.sdcppUpscaling,
};
