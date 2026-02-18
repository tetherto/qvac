#pragma once

#include <functional>
#include <string>
#include <thread>
#include <unordered_map>

#include "ParakeetConfig.hpp"
#include "addon/ParakeetErrors.hpp"
#include "model-interface/ParakeetTypes.hpp"

namespace qvac_lib_infer_parakeet {

/**
 * Handler function type for processing JS config values
 * @tparam Params The parameter struct type to modify
 */
template <typename Params>
using HandlerFunction = std::function<void(Params &, const JSValueVariant &)>;

/**
 * Map of parameter names to their handler functions
 * @tparam Params The parameter struct type
 */
template <typename Params>
using HandlersMap = std::unordered_map<std::string, HandlerFunction<Params>>;

/**
 * Miscellaneous configuration not part of core ParakeetConfig
 * Used for additional options that affect model behavior
 */
struct MiscConfig {
  bool captionEnabled = false;   // Enable caption/subtitle mode
  bool timestampsEnabled = true; // Include timestamps in output
  int seed = -1;                 // Random seed (-1 for random)
};

/**
 * Compute optimal thread count based on hardware
 * @return Half of hardware threads, minimum 1
 */
int computeOptimalThreads();

// Handler maps for different configuration categories
extern const HandlersMap<ParakeetConfig> PARAKEET_MODEL_HANDLERS;
extern const HandlersMap<ParakeetConfig> PARAKEET_AUDIO_HANDLERS;
extern const HandlersMap<ParakeetConfig> PARAKEET_TRANSCRIPTION_HANDLERS;
extern const HandlersMap<MiscConfig> PARAKEET_MISC_HANDLERS;

} // namespace qvac_lib_infer_parakeet
