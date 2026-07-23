#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

#include <stable-diffusion.h>

namespace sd_backend_selection {

enum class BackendDevice : uint8_t { CPU, GPU };

/** How a `main-gpu` config value selects the compute device. */
enum class MainGpuKind : uint8_t { Index, Integrated, Dedicated };

struct MainGpuSpec {
  MainGpuKind kind;
  int index; // valid only when kind == Index
};

/**
 * Parse a `main-gpu` config value. Accepts a non-negative integer device index,
 * "integrated", or "dedicated" (case-insensitive). Returns nullopt for an empty
 * string (no preference). Numeric indices count GPU/iGPU devices only, not the
 * CPU entry in ggml's raw device list. Throws StatusError on any other value.
 */
std::optional<MainGpuSpec> parseMainGpu(const std::string& spec);

/**
 * Read the "main-gpu" (or "main_gpu") key from a config map. Returns the raw
 * string, or nullopt when absent. Throws if both spellings are present.
 */
std::optional<std::string>
mainGpuFromMap(const std::unordered_map<std::string, std::string>& configMap);

/** A ggml device normalized for main-gpu selection. */
enum class GpuClass : uint8_t { Other, Integrated, Dedicated };

struct GpuCandidate {
  std::string name;
  GpuClass cls;
  size_t totalVram;
  std::string description;
};

/**
 * Pure main-gpu selection over a normalized device list (no ggml enumeration,
 * so it is unit-testable). For Index, returns the nth GPU/iGPU device if in
 * range, skipping CPU/other devices. For Dedicated/Integrated, returns the
 * matching-class device with the most VRAM (first wins on ties). Returns
 * nullopt when no device matches or the selected device has an empty name.
 */
std::optional<std::string> selectMainGpuName(
    const std::vector<GpuCandidate>& devices, const MainGpuSpec& spec);

/**
 * Resolve a `main-gpu` spec to a concrete ggml device backend name (e.g.
 * "Vulkan1") suitable for `sd_ctx_params_t.backend`. Enumerates ggml devices
 * into GpuCandidates and defers the pick to selectMainGpuName:
 *   - Dedicated  -> the GGML_BACKEND_DEVICE_TYPE_GPU device with the most VRAM
 *                   (except OpenCL Adreno devices, which ggml reports as GPU)
 *   - Integrated -> the GGML_BACKEND_DEVICE_TYPE_IGPU device with the most VRAM
 *                   or an OpenCL Adreno device reported as GPU
 *   - Index      -> the nth GPU/iGPU device, if in range
 * Returns nullopt when no matching device exists (caller leaves backend unset
 * and the default preference applies — never forces an empty device set).
 */
std::optional<std::string> resolveMainGpuBackendName(const MainGpuSpec& spec);

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
 *   Adreno / other GPU -> GPU (Adreno prefers OpenCL when available, see
 *                              shouldPreferOpenClForAdreno; otherwise Vulkan
 *                              or another backend)
 *   User-requested CPU -> CPU
 *
 * Returns the resolved BackendDevice.
 */
BackendDevice resolveBackendForDevice(BackendDevice preferred);

/**
 * Returns true when runtime device probing indicates that OpenCL should be
 * preferred for Adreno GPUs (an Adreno GPU and an OpenCL backend are both
 * present). This only applies when preferred is GPU; CPU preference always
 * returns false.
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
 * Elsewhere mirrors resolveBackendForDevice().
 */
std::string expectedEsrganBackendDeviceForConfig(const std::string& device);

} // namespace sd_backend_selection
