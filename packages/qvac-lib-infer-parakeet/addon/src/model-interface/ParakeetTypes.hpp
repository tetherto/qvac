#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <variant>
#include <vector>

namespace qvac_lib_infer_parakeet {

/**
 * Transcription result segment
 */
struct Transcript {
  std::string text;
  bool toAppend;
  float start;
  float end;
  size_t id;

  Transcript() : toAppend{false}, start(-1.0F), end(-1.0F), id{0} {}

  explicit Transcript(std::string_view strView)
      : text{strView}, toAppend{false}, start{-1.0F}, end{-1.0F}, id{0} {}
};

/**
 * Model types supported by Parakeet
 */
enum class ModelType : std::uint8_t {
  CTC,        // English-only, fast transcription with punctuation/capitalization
  TDT,        // Multilingual (~25 languages) with auto-detection
  EOU,        // Real-time streaming with end-of-utterance detection
  SORTFORMER  // Speaker diarization (up to 4 speakers)
};

/**
 * Audio input for transcription
 */
struct AudioInput {
  std::vector<float> audioData;  // Audio samples (normalized to [-1, 1])
  int sampleRate = 16000;
  int channels = 1;
};

/**
 * Transcription result
 */
struct TranscriptionResult {
  std::string text;
  float confidence = 0.0f;
  bool isFinal = true;

  // Optional diarization info
  int speakerId = -1;
  float startTime = 0.0f;
  float endTime = 0.0f;
};

/**
 * Speaker segment from diarization (Sortformer)
 */
struct SpeakerSegment {
  float start = 0.0f;
  float end = 0.0f;
  int speakerId = -1;
};

/**
 * Configuration for Sortformer post-processing.
 * Pre-tuned for CallHome dataset (NVIDIA defaults).
 */
struct DiarizationConfig {
  float onset = 0.641f;
  float offset = 0.561f;
  float padOnset = 0.229f;
  float padOffset = 0.079f;
  float minDurationOn = 0.511f;
  float minDurationOff = 0.296f;
  int medianWindow = 11;
};

// JS value variant type for config parsing
using JSValueVariant =
    std::variant<bool, int32_t, int64_t, float, double, std::string>;

} // namespace qvac_lib_infer_parakeet

