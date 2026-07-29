#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace qvac_lib_inference_addon_whisper {

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

  Transcript() = default;

  explicit Transcript(std::string_view strView) : text{strView} {}
};

enum class TranscriptionProfile : std::uint8_t {
  Default,
  Vad,
};

} // namespace qvac_lib_inference_addon_whisper
