#pragma once

#include <cstdint>
#include <string>

#include "qvac-lib-inference-addon-cpp/Errors.hpp"

namespace qvac_lib_inference_addon_bci::errors {
constexpr const char* ADDON_ID = "BCI";
} // namespace qvac_lib_inference_addon_bci::errors

namespace qvac_errors {
namespace bci_error {
enum class Code : std::uint8_t {
  InvalidNeuralSignal,
};

inline const char* codeName(Code code) {
  switch (code) {
    case Code::InvalidNeuralSignal:
      return "InvalidNeuralSignal";
  }
  return "BCIError";
}

inline qvac_errors::StatusError
makeStatus(Code code, const std::string& message) {
  return qvac_errors::StatusError(
      qvac_lib_inference_addon_bci::errors::ADDON_ID,
      codeName(code),
      message);
}
} // namespace bci_error
} // namespace qvac_errors
