#pragma once

#include <algorithm>
#include <cctype>
#include <charconv>
#include <cmath>
#include <limits>
#include <stdexcept>
#include <string>
#include <variant>
#include <vector>

namespace main_gpu {

enum class Kind { Automatic, Index, Dedicated, Integrated };
struct Selector {
  Kind kind = Kind::Automatic;
  int index = 0;
};

inline bool isSelectorKey(const std::string& key) {
  return key == "main-gpu" || key == "main_gpu";
}

template <typename ConfigMap> Selector parse(const ConfigMap& config) {
  const auto canonical = config.find("main-gpu");
  const auto alias = config.find("main_gpu");
  if (canonical != config.end() && alias != config.end()) {
    throw std::invalid_argument("Use only one of main-gpu and main_gpu");
  }
  const auto it = canonical != config.end() ? canonical : alias;
  if (it == config.end())
    return {};
  if (config.contains("gpu_device")) {
    throw std::invalid_argument("main-gpu cannot be combined with gpu_device");
  }
  if (const auto* text = std::get_if<std::string>(&it->second)) {
    std::string name = *text;
    std::transform(name.begin(), name.end(), name.begin(), [](unsigned char c) {
      return static_cast<char>(std::tolower(c));
    });
    if (name == "dedicated")
      return {Kind::Dedicated};
    if (name == "integrated")
      return {Kind::Integrated};
    int index = 0;
    const char* begin = text->data();
    const char* end = begin + text->size();
    const char* digits = begin;
    if (digits != end && (*digits == '+' || *digits == '-'))
      ++digits;
    if (digits == end || !std::all_of(digits, end, [](unsigned char c) {
          return c >= '0' && c <= '9';
        })) {
      throw std::invalid_argument(
          "main-gpu must be a 32-bit integer registry index, 'dedicated', or "
          "'integrated'");
    }
    if (*begin == '+')
      ++begin;
    const auto result = std::from_chars(begin, end, index);
    if (result.ec == std::errc{} && result.ptr == end)
      return {Kind::Index, index};
    throw std::invalid_argument(
        "main-gpu must be a 32-bit integer registry index, 'dedicated', or "
        "'integrated'");
  }
  double number = std::numeric_limits<double>::quiet_NaN();
  if (const auto* value = std::get_if<int>(&it->second))
    number = *value;
  if (const auto* value = std::get_if<double>(&it->second))
    number = *value;
  if (std::isfinite(number) && number >= std::numeric_limits<int>::min() &&
      std::floor(number) == number &&
      number <= std::numeric_limits<int>::max()) {
    return {Kind::Index, static_cast<int>(number)};
  }
  throw std::invalid_argument(
      "main-gpu must be a 32-bit integer registry index, 'dedicated', or "
      "'integrated'");
}

// Keep every registry slot, including CPU and excluded backends. Whisper's
// ordinal counts all GPU/IGPU devices, including those excluded by our policy.
// `identity` is populated for GPU-type slots so the CPU-fallback warning can
// name every device the allowlist and safety guards refused.
struct Device {
  int whisperIndex = -1;
  bool integrated = false;
  bool eligible = false;
  bool adrenoOpencl = false;
  std::string identity;
};
struct Selection {
  int whisperIndex = -1; // -1 means CPU.
  bool outOfRange = false;
  // GPU-type registry slots that were seen but not chosen. Populated only when
  // the selection falls back to CPU so callers can log an actionable reason.
  std::vector<std::string> refused;
};

inline std::vector<std::string>
refusedIdentities(const std::vector<Device>& registry) {
  std::vector<std::string> refused;
  for (const auto& device : registry) {
    if (device.whisperIndex >= 0 && !device.eligible &&
        !device.identity.empty()) {
      refused.push_back(device.identity);
    }
  }
  return refused;
}

inline Selection
select(const std::vector<Device>& registry, Selector selector) {
  bool outOfRange = false;
  if (selector.kind == Kind::Index) {
    if (selector.index >= 0 &&
        static_cast<size_t>(selector.index) < registry.size()) {
      const auto& selected = registry[selector.index];
      if (selected.eligible) {
        return {selected.whisperIndex};
      }
      return {-1, false, refusedIdentities(registry)};
    }
    outOfRange = true;
    selector.kind = Kind::Automatic;
  }
  // Dedicated is the default class preference. An explicit class is strict.
  for (bool integrated : {false, true}) {
    if ((selector.kind == Kind::Dedicated && integrated) ||
        (selector.kind == Kind::Integrated && !integrated))
      continue;
    // Retain the validated Adreno OpenCL preference within the requested class.
    for (bool adreno : {true, false}) {
      for (const auto& device : registry) {
        if (device.eligible && device.integrated == integrated &&
            device.adrenoOpencl == adreno) {
          return {device.whisperIndex, outOfRange};
        }
      }
    }
  }
  return {-1, outOfRange, refusedIdentities(registry)};
}

} // namespace main_gpu
