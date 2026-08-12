#pragma once

#include <string>

#include <tts-cpp/supertonic/engine.h>

#include "model-interface/supertonic/SupertonicConfig.hpp"

namespace qvac::ttsggml::supertonic::detail {

// Vulkan pipeline-cache env key + pre-warm sentence, named so the values are
// discoverable/tunable instead of buried in logic.
inline constexpr char VULKAN_PIPELINE_CACHE_DIR_ENV[] =
    "GGML_VK_PIPELINE_CACHE_DIR";
inline constexpr char VULKAN_PREWARM_TEXT[] = "The quick brown fox.";

// Opt-in only (GPU run + a caller-provided cache dir): persist the compiled
// Vulkan pipelines across launches and warm them at load() so the first run()
// avoids the Mali first-dispatch compile stall. No-op otherwise, and never
// overwrites a pre-warm text the caller already set.
void applyVulkanPipelineCache(
    tts_cpp::supertonic::EngineOptions& opts, const SupertonicConfig& cfg);

// Conditioning reaches supertonic through EngineOptions at construction, and
// tts_cpp::supertonic::Engine::synthesize() takes text only. Reject a per-call
// value instead of accepting one the engine will never see.
void validateNoPerCallControls(
    const std::string& emotion, const std::string& pace);

} // namespace qvac::ttsggml::supertonic::detail
