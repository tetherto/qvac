#pragma once

#include <cstdint>
#include <string>

#include "qvac-lib-inference-addon-cpp/Errors.hpp"

namespace qvac_lib_infer_parakeet::errors {

constexpr const char* ADDON_ID = "Parakeet";

enum class Code : std::uint8_t {
  EncoderNotLoaded,
  DecoderNotLoaded,
  CTCModelNotLoaded,
  SortformerNotLoaded,
  EOUEncoderNotLoaded,
  EOUDecoderNotLoaded,
  SessionInitFailed,
  VocabularyEmpty,
  AudioTooShort,
  InferenceFailed,
  ModelNotReady,
};

inline std::string toString(Code code) {
  switch (code) {
  case Code::EncoderNotLoaded:
    return "EncoderNotLoaded";
  case Code::DecoderNotLoaded:
    return "DecoderNotLoaded";
  case Code::CTCModelNotLoaded:
    return "CTCModelNotLoaded";
  case Code::SortformerNotLoaded:
    return "SortformerNotLoaded";
  case Code::EOUEncoderNotLoaded:
    return "EOUEncoderNotLoaded";
  case Code::EOUDecoderNotLoaded:
    return "EOUDecoderNotLoaded";
  case Code::SessionInitFailed:
    return "SessionInitFailed";
  case Code::VocabularyEmpty:
    return "VocabularyEmpty";
  case Code::AudioTooShort:
    return "AudioTooShort";
  case Code::InferenceFailed:
    return "InferenceFailed";
  case Code::ModelNotReady:
    return "ModelNotReady";
  }
  return "UnknownError";
}

inline qvac_errors::StatusError
makeStatus(Code code, const std::string& message) {
  return qvac_errors::StatusError(ADDON_ID, toString(code), message);
}

} // namespace qvac_lib_infer_parakeet::errors
