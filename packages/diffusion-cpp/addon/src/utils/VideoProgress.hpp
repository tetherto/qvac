#pragma once

namespace qvac_lib_inference_addon_sd {

/**
 * Return the number of leading sampler progress sequences expected for a video
 * generation. A loaded A14B high-noise expert normally contributes a second
 * sequence, except when the native -1 sentinel with a zero moe_boundary
 * resolves to no high-noise sampler invocation.
 */
constexpr int expectedVideoDenoiseSequences(
    bool hasLoadedHighNoiseExpert, int highNoiseSteps, float moeBoundary) {
  const bool skipsHighNoiseSampler =
      highNoiseSteps == -1 && moeBoundary == 0.0f;
  return hasLoadedHighNoiseExpert && !skipsHighNoiseSampler ? 2 : 1;
}

} // namespace qvac_lib_inference_addon_sd
