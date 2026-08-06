#pragma once
#include <charconv>
#include <stdexcept>
#include <string>

namespace qvac_lib_inference_addon_llama {

/// Parses @p raw as an unsigned decimal integer in [@p min, @p max]. The whole
/// string must be consumed: empty input, signs, whitespace, trailing
/// characters, and out-of-range values all throw std::invalid_argument naming
/// @p option (plain std exception so this header stays free of binding
/// dependencies; callers translate it).
inline unsigned parseUnsignedInRange(
    const std::string& raw, unsigned min, unsigned max,
    const std::string& option) {
  const auto fail = [&]() -> unsigned {
    throw std::invalid_argument(
        option + " must be an integer between " + std::to_string(min) +
        " and " + std::to_string(max) + ", got: \"" + raw + "\"");
  };

  unsigned value = 0;
  const char* first = raw.data();
  const char* last = raw.data() + raw.size();
  auto [ptr, ec] = std::from_chars(first, last, value);
  if (ec != std::errc{} || ptr != last)
    return fail();
  if (value < min || value > max)
    return fail();
  return value;
}

} // namespace qvac_lib_inference_addon_llama
