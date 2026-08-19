#pragma once

#include <memory>
#include <string>

#include <tts-cpp/lavasr/denoiser.h>

#include "addon/TTSErrors.hpp"

namespace qvac::ttsggml {

// Shared LavaSR-denoiser load path for the model backends. Every engine treats
// the denoiser identically (batch-only, rate-preserving, runs before the
// enhancer), so the logic lives in one place to keep the loaders from drifting
// — the same reason loadEnhancer exists.
//
// Unlike the enhancer there is no device switch: tts-cpp exposes a plain
// Denoiser::load(), so there are no backend codes to report either.
//
//   ggufPath      empty => denoiser disabled (returns null).
//   errorContext  prefix for the InitializationFailed message on load failure.
//
// The UL-UNAS forward is implemented in qvac-ext-lib-whisper.cpp PR #78; an
// older tts-cpp pin (pre-#78) makes Denoiser::load throw, surfacing here as a
// clean InitializationFailed error.
inline std::shared_ptr<tts_cpp::lavasr::Denoiser>
loadDenoiser(const std::string& ggufPath, const std::string& errorContext) {
  if (ggufPath.empty())
    return nullptr;
  try {
    return tts_cpp::lavasr::Denoiser::load(ggufPath);
  } catch (const std::exception& e) {
    throw qvac_errors::createTTSError(
        qvac_errors::tts_error::InitializationFailed, errorContext + e.what());
  }
}

} // namespace qvac::ttsggml
