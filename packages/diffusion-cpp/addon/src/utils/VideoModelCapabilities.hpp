#pragma once

#include <string>

namespace qvac_lib_inference_addon_sd {

/**
 * Constraints derived from the actual diffusion-model file at context load.
 *
 * Defaults preserve the existing Wan 2.1-compatible 16-pixel grid when the
 * model format is unknown or does not expose a stricter video capability.
 */
struct VideoModelCapabilities {
  int spatialAlignment = 16;
};

/**
 * Inspect a GGUF's tensor descriptors to determine video constraints without
 * relying on the caller-controlled filename. Malformed and unsupported model
 * files return the safe default capability set; stable-diffusion.cpp remains
 * responsible for accepting or rejecting those files during context creation.
 */
VideoModelCapabilities
inspectVideoModelCapabilities(const std::string& modelPath);

} // namespace qvac_lib_inference_addon_sd
