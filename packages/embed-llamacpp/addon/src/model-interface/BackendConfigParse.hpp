#pragma once

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <exception>
#include <optional>
#include <string>
#include <variant>

#include <inference-addon-cpp/Errors.hpp>

namespace backend_selection {

enum BackendType : std::uint8_t { CPU, GPU };

enum class MainGpuType : std::uint8_t { Integrated, Dedicated };

using MainGpu = std::variant<int, MainGpuType>;

inline BackendType preferredBackendTypeFromString(const std::string& device) {
  if (device == "gpu") {
    return BackendType::GPU;
  }
  if (device == "cpu") {
    return BackendType::CPU;
  }
  throw qvac_errors::StatusError(
      qvac_errors::general_error::InvalidArgument,
      "preferredDeviceFromString: wrong device specified, must be 'gpu' or "
      "'cpu'.\n");
}

inline std::optional<MainGpu> parseMainGpu(const std::string& mainGpuStr) {
  if (mainGpuStr.empty()) {
    return std::nullopt;
  }

  // Try to parse as integer first
  try {
    int deviceIndex = std::stoi(mainGpuStr);
    return MainGpu(deviceIndex);
  } catch (const std::exception&) {
    // Not an integer, try enum values
    std::string lowerStr = mainGpuStr;
    std::ranges::transform(lowerStr, lowerStr.begin(), [](unsigned char c) {
      return static_cast<char>(std::tolower(c));
    });

    if (lowerStr == "integrated") {
      return MainGpu(MainGpuType::Integrated);
    }
    if (lowerStr == "dedicated") {
      return MainGpu(MainGpuType::Dedicated);
    }
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "main-gpu must be an integer device index, 'integrated', or "
        "'dedicated'");
  }
}

} // namespace backend_selection
