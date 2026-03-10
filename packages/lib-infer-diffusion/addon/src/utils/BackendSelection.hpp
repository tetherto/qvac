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

/**
 * Resolve the effective backend for stable-diffusion.cpp by inspecting
 * available ggml devices at runtime.
 *
 * Priority:
 *   Adreno 800+  -> GPU (OpenCL will be selected by init_backend)
 *   Adreno 600/700 -> CPU (OpenCL works but is slow; force CPU)
 *   Everything else -> GPU (Vulkan or other backend via init_backend)
 *
 * Returns the resolved BackendDevice.
 */
BackendDevice resolveBackendForDevice(BackendDevice preferred);

} // namespace sd_backend_selection
