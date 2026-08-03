#pragma once

#include <cstdint>
#include <string>

#include "inference-addon-cpp/Errors.hpp"

// Merged per-engine error tables for the unified asr-ggml addon.
//
// Codes are string-typed at the JS boundary (`StatusError.codeString()` ->
// "[ Whisper :: MisalignedBuffer ]"), so the two engines' tables need no
// numeric de-confliction natively; the numeric QvacErrorAddon* maps live in
// the JS drivers. The two ADDON_ID strings are preserved verbatim so each
// engine's existing log / error-message text is unchanged.
namespace qvac::asrggml::errors {

namespace whisper {

constexpr const char* ADDON_ID = "Whisper";

enum class Code : std::uint8_t {
  UnableToCreateWhisperContext,
  UnableToTranscribe,
  UnableToCreateVadContext,
  UnableToDetectVADSegments,
  MisalignedBuffer,
  NonFiniteSample,
  UnsupportedAudioFormat,
};

inline std::string toString(Code code) {
  switch (code) {
  case Code::UnableToCreateWhisperContext:
    return "UnableToCreateWhisperContext";
  case Code::UnableToTranscribe:
    return "UnableToTranscribe";
  case Code::UnableToCreateVadContext:
    return "UnableToCreateVadContext";
  case Code::UnableToDetectVADSegments:
    return "UnableToDetectVADSegments";
  case Code::MisalignedBuffer:
    return "MisalignedBuffer";
  case Code::NonFiniteSample:
    return "NonFiniteSample";
  case Code::UnsupportedAudioFormat:
    return "UnsupportedAudioFormat";
  }
  return "UnknownError";
}

inline qvac_errors::StatusError
makeStatus(Code code, const std::string& message) {
  // The pre-merge whisper makeStatus ignored `code` and always emitted
  // "WhisperError"; it now emits the real code name (message-text-only
  // change -- no JS driver pattern-matches codeString()).
  return {ADDON_ID, toString(code), message};
}

} // namespace whisper

namespace parakeet {

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
  // reload() is whisper-only; the parakeet arm of the unified verb throws
  // this (destroy and recreate the instance instead).
  ReloadNotSupported,
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
  case Code::ReloadNotSupported:
    return "ReloadNotSupported";
  }
  return "UnknownError";
}

inline qvac_errors::StatusError
makeStatus(Code code, const std::string& message) {
  return {ADDON_ID, toString(code), message};
}

} // namespace parakeet

} // namespace qvac::asrggml::errors
