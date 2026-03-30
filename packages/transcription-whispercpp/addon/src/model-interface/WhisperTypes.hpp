#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace qvac_lib_inference_addon_whisper {

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

enum class TranscriptionProfile : std::uint8_t {
  Default,
  Vad,
};

} // namespace qvac_lib_inference_addon_whisper
