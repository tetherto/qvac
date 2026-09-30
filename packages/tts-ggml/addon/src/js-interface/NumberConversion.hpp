#pragma once

#include <cmath>
#include <limits>
#include <optional>

// JS numbers are doubles. Converting one that the target type cannot represent
// is undefined behaviour in C++, so JSAdapter converts through these checks and
// rejects the value instead. Kept JS-free so it is unit-testable.
namespace qvac::ttsggml {

// Truncates toward zero like the plain cast it replaces; nullopt for NaN,
// infinity, or a value outside the int range.
inline std::optional<int> intFromJsNumber(double value) {
  if (!std::isfinite(value)) {
    return std::nullopt;
  }
  const double truncated = std::trunc(value);
  if (truncated < static_cast<double>(std::numeric_limits<int>::min()) ||
      truncated > static_cast<double>(std::numeric_limits<int>::max())) {
    return std::nullopt;
  }
  return static_cast<int>(truncated);
}

// NaN and infinity convert exactly and are left to each option's own range
// check; nullopt only for a finite value beyond the float range.
inline std::optional<float> floatFromJsNumber(double value) {
  if (std::isfinite(value) &&
      std::abs(value) >
          static_cast<double>(std::numeric_limits<float>::max())) {
    return std::nullopt;
  }
  return static_cast<float>(value);
}

} // namespace qvac::ttsggml
