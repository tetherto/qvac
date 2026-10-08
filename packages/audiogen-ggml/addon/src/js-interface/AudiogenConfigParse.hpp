#pragma once

#include <cmath>
#include <limits>
#include <string>

#include "inference-addon-cpp/Errors.hpp"

namespace qvac::audiogenggml {

namespace general_error = qvac_errors::general_error;

[[noreturn]] inline void
throwInvalidNumber(const char* key, const char* typeName) {
  throw qvac_errors::StatusError(
      general_error::InvalidArgument,
      std::string("Property '") + key + "' must be " + typeName);
}

inline int checkedInteger(double value, const char* key) {
  const double minimum = std::numeric_limits<int>::min();
  const double maximum = std::numeric_limits<int>::max();
  if (!std::isfinite(value) || std::trunc(value) != value || value < minimum ||
      value > maximum) {
    throwInvalidNumber(key, "a finite int32 integer");
  }
  return static_cast<int>(value);
}

inline int parseInteger(const std::string& value, const char* key) {
  std::size_t consumed = 0;
  long long parsed = 0;
  try {
    parsed = std::stoll(value, &consumed);
  } catch (const std::exception&) {
    throwInvalidNumber(key, "a finite int32 integer");
  }
  if (consumed != value.size() || parsed < std::numeric_limits<int>::min() ||
      parsed > std::numeric_limits<int>::max()) {
    throwInvalidNumber(key, "a finite int32 integer");
  }
  return static_cast<int>(parsed);
}

inline float checkedFloat(double value, const char* key) {
  const double maximum = std::numeric_limits<float>::max();
  if (!std::isfinite(value) || value < -maximum || value > maximum) {
    throwInvalidNumber(key, "a finite float32 number");
  }
  return static_cast<float>(value);
}

inline float parseFloat(const std::string& value, const char* key) {
  std::size_t consumed = 0;
  float parsed = 0.0F;
  try {
    parsed = std::stof(value, &consumed);
  } catch (const std::exception&) {
    throwInvalidNumber(key, "a finite float32 number");
  }
  if (consumed != value.size() || !std::isfinite(parsed)) {
    throwInvalidNumber(key, "a finite float32 number");
  }
  return parsed;
}

} // namespace qvac::audiogenggml
