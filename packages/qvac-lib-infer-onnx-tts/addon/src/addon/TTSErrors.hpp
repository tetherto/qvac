#pragma once

#include <cstdint>
#include <string>

#include "qvac-lib-inference-addon-cpp/Errors.hpp"

namespace qvac_errors {

namespace tts_error {

constexpr std::string_view TTSAddonId = /* NOLINT(readability-identifier-naming) */ "TTS";

enum TTSErrorCode : uint32_t {
  OK = 0,
  ModelNotLoaded = 1,
  ModelFileNotFound = 2,
  ConfigFileNotFound = 3,
  InvalidAPI = 4,
  InitializationFailed = 5,
  SynthesisFailed = 6,
};

inline std::string toString(uint32_t code) {
  switch (code) {
  case 0:
    return "OK";
  case 1:
    return "ModelNotLoaded";
  case 2:
    return "ModelFileNotFound";
  case 3:
    return "ConfigFileNotFound";
  case 4:
    return "InvalidAPI";
  case 5:
    return "InitializationFailed";
  case 6:
    return "SynthesisFailed";
  default:
    return "UnknownTTSError";
  }
}

} // namespace tts_error

// Convenience function to create TTS-specific StatusError
inline StatusError createTTSError(tts_error::TTSErrorCode code, const std::string& message) {
  return StatusError(std::string(tts_error::TTSAddonId), tts_error::toString(code), message);
}

} // namespace qvac_errors 