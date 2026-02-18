#pragma once

#include <cstdint>
#include <string>

#include "qvac-lib-inference-addon-cpp/Errors.hpp"

namespace qvac_lib_infer_parakeet::errors {

constexpr const char* ADDON_ID = "Parakeet";

enum ParakeetErrorCode : std::uint8_t {
  UnableToLoadModel,
  UnableToTranscribe,
  MisalignedBuffer,
  NonFiniteSample,
  UnsupportedAudioFormat,
  InvalidModelType,
  SessionNotInitialized,
};

inline std::string toString(ParakeetErrorCode code) {
  switch (code) {
  case UnableToLoadModel:
    return "UnableToLoadModel";
  case UnableToTranscribe:
    return "UnableToTranscribe";
  case MisalignedBuffer:
    return "MisalignedBuffer";
  case NonFiniteSample:
    return "NonFiniteSample";
  case UnsupportedAudioFormat:
    return "UnsupportedAudioFormat";
  case InvalidModelType:
    return "InvalidModelType";
  case SessionNotInitialized:
    return "SessionNotInitialized";
  default:
    return "UnknownError";
  }
}

} // namespace qvac_lib_infer_parakeet::errors

namespace qvac_errors {
namespace parakeet_error {

enum class Code : std::uint8_t {
  MisalignedBuffer,
  NonFiniteSample,
  UnsupportedAudioFormat,
};

inline qvac_errors::StatusError
makeStatus(Code code, const std::string& message) {
  return qvac_errors::StatusError("Parakeet", "ParakeetError", message);
}

} // namespace parakeet_error
} // namespace qvac_errors

