#pragma once

#include <cstdint>
#include <string>

#include "qvac-lib-inference-addon-cpp/Errors.hpp"

namespace qvac_lib_inference_addon_whisper::errors {
constexpr const char* ADDON_ID = "Whisper";

enum WhisperErrorCode : std::uint8_t {
  UnableToCreateWhisperContext,
  UnableToTranscribe,
  UnableToCreateVadContext,
  UnableToDetectVADSegments,
  MisalignedBuffer,
  NonFiniteSample,
  UnsupportedAudioFormat,
};

inline std::string toString(WhisperErrorCode code) {
  switch (code) {
  case UnableToCreateWhisperContext:
    return "UnableToCreateWhisperContext";
  case UnableToTranscribe:
    return "UnableToTranscribe";
  case UnableToCreateVadContext:
    return "UnableToCreateVadContext";
  case UnableToDetectVADSegments:
    return "UnableToDetectVADSegments";
  case MisalignedBuffer:
    return "MisalignedBuffer";
  case NonFiniteSample:
    return "NonFiniteSample";
  case UnsupportedAudioFormat:
    return "UnsupportedAudioFormat";
  default:
    return "UnknownError";
  }
}
} // namespace qvac_lib_inference_addon_whisper::errors

namespace qvac_errors {
namespace whisper_error {
enum class Code : std::uint8_t {
  MisalignedBuffer,
  NonFiniteSample,
  UnsupportedAudioFormat,
};

inline qvac_errors::StatusError
makeStatus(Code code, const std::string& message) {
  return qvac_errors::StatusError("Whisper", "WhisperError", message);
}
} // namespace whisper_error
} // namespace qvac_errors
