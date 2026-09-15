#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <unordered_map>
#include <variant>
#include <vector>

#include <inference-addon-cpp/Errors.hpp>
#include <llama.h>

namespace backend_selection {

enum BackendType : std::uint8_t { CPU, GPU };

enum class MainGpuType : std::uint8_t { Integrated, Dedicated };

using MainGpu = std::variant<int, MainGpuType>;

BackendType preferredBackendTypeFromString(const std::string& device);

std::optional<MainGpu> parseMainGpu(const std::string& mainGpuStr);

std::optional<MainGpu>
tryMainGpuFromMap(std::unordered_map<std::string, std::string>& configFilemap);

/// @brief Parse a `backend` override into a lowercased priority list, e.g.
/// "CUDA,Vulkan" -> {"cuda", "vulkan"}.
///
/// An unknown name is a config mistake and throws StatusError(InvalidArgument).
/// A known name with no device attached is legitimate, asking for cuda on a
/// Vulkan-only host say, and falls through to the next entry. "auto" is
/// accepted and dropped, so it parses to no preference.
std::vector<std::string> parseBackendOverride(const std::string& backendStr);

/// @brief Extract and erase the `backend` key from a config map.
/// Returns an empty vector when the key is absent.
std::vector<std::string> tryBackendOverrideFromMap(
    std::unordered_map<std::string, std::string>& configFilemap);

using llamaLogCallbackF =
    void (*)(ggml_log_level level, const char* text, void* userData);

struct BackendInterface {
  size_t (*ggml_backend_dev_count)();
  ggml_backend_reg_t (*ggml_backend_dev_backend_reg)(ggml_backend_dev_t device);
  ggml_backend_dev_t (*ggml_backend_dev_get)(size_t index);
  const char* (*ggml_backend_reg_name)(ggml_backend_reg_t reg);
  const char* (*ggml_backend_dev_description)(ggml_backend_dev_t device);
  const char* (*ggml_backend_dev_name)(ggml_backend_dev_t device);
  enum ggml_backend_dev_type (*ggml_backend_dev_type)(
      ggml_backend_dev_t device);
  void (*ggml_backend_dev_get_props)(
      ggml_backend_dev_t device, struct ggml_backend_dev_props* props);
  llamaLogCallbackF llamaLogCallback;
};

struct SplitDevice {
  std::string name;
  ggml_backend_dev_t handle;
  size_t sourceGpuIndex;
  bool isOpenCl;
  bool isRpc = false;
};

struct SplitDeviceSelection {
  std::vector<SplitDevice> devices;
  size_t sourceGpuCount = 0;
  std::vector<std::string> rejectedDevices;
};

std::pair<BackendType, std::string> chooseBackend(
    BackendType preferredBackendType, const BackendInterface& bckI,
    const std::optional<MainGpu>& mainGpu = std::nullopt,
    const std::vector<std::string>& backendOverride = {});

/// @brief Choose the backend to use for the model based on GPU device and
/// available backends. Prefer OpenCL backend for Adreno GPUs, then CUDA on
/// NVIDIA, otherwise Vulkan. Uses CPU if no GPU backends are available.
///
/// The CUDA preference is stated here rather than inherited: qvac-fabric loads
/// cuda before vulkan and registration is an unsorted push_back, so CUDA
/// already happens to enumerate first. Relying on that would make backend
/// choice a silent function of ggml's load order. QVAC-23763.
///
/// @p backendOverride, when non-empty, restricts the choice to those backend
/// families in priority order (e.g. {"cuda", "vulkan"}). Entries with no device
/// present are skipped; if none match, selection falls through to the normal
/// cascade rather than failing, because an absent device is not a config error.
std::pair<BackendType, std::string> chooseBackend(
    BackendType preferredBackendType, llamaLogCallbackF llamaLogcallback,
    const std::optional<MainGpu>& mainGpu = std::nullopt,
    const std::vector<std::string>& backendOverride = {});

/// @brief Count devices in the final Fabric-compatible split set.
size_t getEffectiveGpuDeviceCount(const BackendInterface& bckI);

/// @brief Select the Fabric-compatible split list for layer split mode.
/// RPC devices first, then discrete GPUs if any are eligible, else integrated;
/// discrete duplicates dropped by raw `ggml_backend_dev_props::device_id`
/// (byte for byte as fabric compares, so CUDA `-vN` devices stay distinct, and
/// a null id is kept). `sourceGpuIndex` keeps each device's position in the raw
/// GPU registry so positional tensor shares can be remapped onto the final
/// list.
SplitDeviceSelection getSplitDeviceSelection(const BackendInterface& bckI);

/// @brief `getSplitDeviceSelection()` against the real ggml registry.
SplitDeviceSelection getSplitDeviceSelection();

/// @brief Eligible split devices, preferring discrete and deduplicating by id.
std::vector<std::string> getSplitDeviceNames(const BackendInterface& bckI);

/// @brief Device names for split mode, preferring the selected backend when
/// one physical GPU is registered by more than one backend.
std::vector<std::string> splitModeDeviceNames(
    const BackendInterface& bckI, const std::string& selectedDeviceName);

std::vector<std::string>
splitModeDeviceNames(const std::string& selectedDeviceName);
} // namespace backend_selection
