#pragma once

#include <cstdint>
#include <string>
#include <unordered_map>

namespace sd_backend_selection {

enum class BackendDevice : uint8_t { CPU, GPU };

/**
 * Parse the "device" key from a config map.
 * Returns CPU or GPU. Throws StatusError on unknown value.
 */
BackendDevice preferredDeviceFromMap(
    const std::unordered_map<std::string, std::string>& configMap);

/**
 * Determine the number of CPU threads from a config map.
 * Returns -1 (auto) if not specified.
 */
int threadsFromMap(
    const std::unordered_map<std::string, std::string>& configMap);

} // namespace sd_backend_selection
