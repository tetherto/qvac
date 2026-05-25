#pragma once

#include <cstdint>
#include <string>
#include <unordered_map>

#include <stable-diffusion.h>

namespace sd_backend_selection {

enum class BackendDevice : uint8_t { CPU, GPU };

/** Validated config.device values shared by SD and ESRGAN upscaler paths. */
enum class ConfigDevice : uint8_t { Cpu, Gpu };

/**
 * Parse config.device. Accepts `cpu` or `gpu`. Throws StatusError on any other
 * value.
 */
ConfigDevice parseConfigDeviceString(const std::string& device);

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

/**
 * Returns true when runtime device probing indicates that OpenCL should be
 * preferred for Adreno 800+ GPUs.
 *
 * This only applies when preferred is GPU. CPU preference always returns false.
 */
bool shouldPreferOpenClForAdreno(BackendDevice preferred);

/**
 * Map config.device to stable-diffusion.cpp preferred_gpu_backend.
 * Omitted device config is handled by SdCtxConfig::device defaulting to `gpu`.
 */
sd_backend_preference_t
preferredGpuBackendForConfigDevice(const std::string& device);

/**
 * ESRGAN-only stable-diffusion.cpp backend preference.
 * On Android, config gpu always uses CPU (native ESRGAN GPU/OpenCL is
 * unstable). Stable Diffusion uses preferredGpuBackendForConfigDevice()
 * instead.
 */
sd_backend_preference_t
preferredEsrganBackendForConfigDevice(const std::string& device);

/**
 * Expected EsrganRuntimeStats.backendDevice ("cpu" or "gpu") after ESRGAN load
 * when config.device is @p device. On Android, gpu always expects "cpu".
 * Elsewhere mirrors resolveBackendForDevice(): Adreno 600/700 + gpu -> "cpu";
 * Adreno 800+ and other GPUs -> "gpu".
 */
std::string expectedEsrganBackendDeviceForConfig(const std::string& device);

} // namespace sd_backend_selection
