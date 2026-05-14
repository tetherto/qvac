#pragma once

#include <functional>
#include <string>
#include <string_view>
#include <unordered_map>

namespace qvac_lib_inference_addon_cpp {

struct TransparentStringHash {
  using is_transparent = void;

  size_t operator()(std::string_view value) const noexcept {
    return std::hash<std::string_view>{}(value);
  }
};

struct TransparentStringEqual {
  using is_transparent = void;

  bool operator()(std::string_view lhs, std::string_view rhs) const noexcept {
    return lhs == rhs;
  }
};

template <class TValue>
using TransparentStringMap =
    std::unordered_map<std::string, TValue, TransparentStringHash, TransparentStringEqual>;

} // namespace qvac_lib_inference_addon_cpp

