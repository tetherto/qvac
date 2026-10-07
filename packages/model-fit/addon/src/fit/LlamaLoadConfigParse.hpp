#pragma once

#include <algorithm>
#include <cctype>
#include <limits>
#include <stdexcept>
#include <string>
#include <string_view>

namespace model_fit {

inline std::string lower(std::string value) {
  std::ranges::transform(value, value.begin(), [](unsigned char character) {
    return static_cast<char>(std::tolower(character));
  });
  return value;
}

inline std::string canonicalKey(std::string key) {
  std::ranges::replace(key, '_', '-');
  return lower(std::move(key));
}

inline int parseInteger(const std::string& value, const std::string& key) {
  size_t consumed = 0;
  long long parsed = 0;
  try {
    parsed = std::stoll(value, &consumed);
  } catch (const std::exception&) {
    throw std::invalid_argument(
        "model-fit: config." + key + " must be an integer string");
  }
  if (consumed != value.size() || parsed < std::numeric_limits<int>::min() ||
      parsed > std::numeric_limits<int>::max()) {
    throw std::invalid_argument(
        "model-fit: config." + key + " must be an integer string");
  }
  return static_cast<int>(parsed);
}

} // namespace model_fit
