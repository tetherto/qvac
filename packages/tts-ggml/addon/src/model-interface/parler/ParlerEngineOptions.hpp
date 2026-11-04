#pragma once

#include <tts-cpp/parler/engine.h>

#include "model-interface/parler/ParlerConfig.hpp"

namespace qvac::ttsggml::parler::detail {

// View of the production config mapping, without loading weights.
tts_cpp::parler::EngineOptions engineOptionsForTests(const ParlerConfig& cfg);

} // namespace qvac::ttsggml::parler::detail
