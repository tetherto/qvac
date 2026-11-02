#pragma once

#include <stdexcept>
#include <string>

#include "inference-addon-cpp/Errors.hpp"

namespace qvac::ttsggml {

namespace general_error = qvac_errors::general_error;

// Attacker-controlled config strings (`stoi` / `stof`) from the JS adapter.
inline int parseIntString(const std::string& str, const char* key) {
  try {
    return std::stoi(str);
  } catch (const std::exception&) {
    throw qvac_errors::StatusError(
        general_error::InvalidArgument,
        std::string("Property '") + key +
            "' must be an integer (got non-numeric string \"" + str + "\")");
  }
}

inline float parseFloatString(const std::string& str, const char* key) {
  try {
    return std::stof(str);
  } catch (const std::exception&) {
    throw qvac_errors::StatusError(
        general_error::InvalidArgument,
        std::string("Property '") + key +
            "' must be a number (got non-numeric string \"" + str + "\")");
  }
}

} // namespace qvac::ttsggml
