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
    const std::optional<MainGpu>& mainGpu = std::nullopt);

/// @brief Choose the backend to use for the model based on GPU device and
/// available backends. Prefer OpenCL backend for Adreno GPUs, otherwise Vulkan
/// backend. Uses CPU if no GPU backends are available.
std::pair<BackendType, std::string> chooseBackend(
    BackendType preferredBackendType, llamaLogCallbackF llamaLogcallback,
    const std::optional<MainGpu>& mainGpu = std::nullopt);

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
} // namespace backend_selection
