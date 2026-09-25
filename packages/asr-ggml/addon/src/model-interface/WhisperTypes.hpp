#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace qvac::asrggml::whisper {

// One decoded text token of a segment (special tokens are left out).
struct TokenData {
  std::string text;
  float start{-1.0F};
  float end{-1.0F};
  float probability{0.0F};
};

struct Transcript {
  std::string text;
  // Reserved output field, part of the JS payload shape (see AddonJs.hpp).
  // The addon always emits false today; it exists so streaming consumers can
  // later distinguish "append to the previous segment" from "replace" without
  // a breaking change to the emitted object.
  bool toAppend{false};
  float start{-1.0F};
  float end{-1.0F};
  size_t id{0};
  // Language the window was decoded in (e.g. "en"); the detected one when
  // `language` is "auto". Empty when whisper reports none.
  std::string language;
  // Probability that the segment's window holds no speech; -1 = unknown.
  float noSpeechProb{-1.0F};
  // tdrz_enable only: the tinydiarize model predicts a speaker turn right
  // after this segment.
  std::optional<bool> speakerTurnNext;
  // token_timestamps only: per-token text, timing and probability.
  std::optional<std::vector<TokenData>> tokens;

  Transcript() = default;

  explicit Transcript(std::string_view strView) : text{strView} {}
};

enum class TranscriptionProfile : std::uint8_t {
  Default,
  Vad,
};

} // namespace qvac::asrggml::whisper
