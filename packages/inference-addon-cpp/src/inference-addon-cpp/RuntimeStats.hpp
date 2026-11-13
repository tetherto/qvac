#pragma once
#include <cstdint>
#include <optional>
#include <string>
#include <type_traits>
#include <utility>
#include <variant>
#include <vector>

namespace qvac_lib_inference_addon_cpp {

using RuntimeStatValue = std::variant<double, int64_t, std::string>;

using RuntimeStats = std::vector<std::pair<std::string, RuntimeStatValue>>;

/// @brief Reads a stat as a number.
/// @return The value widened to double, or std::nullopt for a string stat.
inline std::optional<double> numericValue(const RuntimeStatValue& value) {
  return std::visit(
      [](const auto& v) -> std::optional<double> {
        if constexpr (std::is_arithmetic_v<std::decay_t<decltype(v)>>) {
          return static_cast<double>(v);
        } else {
          return std::nullopt;
        }
      },
      value);
}
} // namespace qvac_lib_inference_addon_cpp
