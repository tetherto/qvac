#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <unordered_map>
#include <variant>
#include <vector>

#include <inference-addon-cpp/Errors.hpp>
#include <llama.h>

class ModelMetaData;

namespace backend_selection {

/// Returns the unsupported architecture name if the model's architecture is not
/// in the supported finetuning list, or std::nullopt if it is supported.
std::optional<std::string>
getUnknownFinetuneArchitecture(const ModelMetaData* metadata);

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
  size_t (*ggml_backend_dev_count)(void);
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

std::pair<BackendType, std::string> chooseBackend(
    BackendType preferredBackendType, const BackendInterface& bckI,
    const ModelMetaData* metadata = nullptr,
    const std::optional<MainGpu>& mainGpu = std::nullopt,
    std::optional<int>* outAdrenoVersion = nullptr, bool isFinetuning = false,
    bool* outIsMaliGpu = nullptr);

/// @brief Choose the backend to use for the model based on GPU device and
/// available backends. Prefer OpenCL backend for Adreno GPUs, otherwise
/// Vulkan backend. Uses CPU if no GPU backends are available.
///
/// For BitNet models with TQ1_0/TQ2_0 quantization on Adreno GPUs:
///   - Adreno 800+: prefer Vulkan over OpenCL
///   - Adreno <800: prefer CPU (TQ kernels run faster on CPU)
///
/// When @p isFinetuning is true, throws StatusError (InvalidArgument) if the
/// model architecture is not in the supported list. For supported archs on
/// Adreno:
///   - Adreno 800+: prefer Vulkan
///   - Adreno <800: CPU
///
/// @p outIsMaliGpu (optional) is set to true when any considered GPU device
/// is an Arm Mali (QVAC-21867: used to pick the per-device-class default for
/// the multimodal projector backend).
std::pair<BackendType, std::string> chooseBackend(
    BackendType preferredBackendType, llamaLogCallbackF llamaLogcallback,
    const std::optional<MainGpu>& mainGpu, const ModelMetaData* metadata,
    std::optional<int>* outAdrenoVersion = nullptr, bool isFinetuning = false,
    bool* outIsMaliGpu = nullptr);

/// @brief Count devices in the final Fabric-compatible split set.
size_t getEffectiveGpuDeviceCount(const BackendInterface& bckI);

struct SplitDevice {
  std::string name;
  ggml_backend_dev_t handle = nullptr;
  size_t sourceGpuIndex = 0;
  bool isRpc = false;
  std::optional<int> adrenoVersion;
  bool isMaliGpu = false;
  bool isOpenCl = false;
  bool isMetal = false;
};

struct SplitDeviceSelection {
  std::vector<SplitDevice> devices;
  size_t sourceGpuCount = 0;
  std::vector<std::string> rejectedDevices;
};

/// @brief The authoritative allowlisted device set for multi-GPU modes.
SplitDeviceSelection getSplitDeviceSelection(const BackendInterface& bckI);

/// @brief `getSplitDeviceSelection()` against the real ggml registry.
SplitDeviceSelection getSplitDeviceSelection();

/// @brief The names of `getSplitDeviceSelection()`'s devices, in order.
///
/// Selection mirrors qvac-fabric's filtered branch (`src/llama.cpp`) while
/// applying this addon's supported-backend allowlist:
///   - CUDA and RPC GPU devices are eligible for their upcoming Fabric builds.
///   - RPC devices are prepended and do not suppress a local integrated GPU.
///   - Local discrete GPUs when any are present, otherwise one integrated GPU.
///   - Duplicates are dropped by `ggml_backend_dev_props::device_id`, the same
///     key fabric uses. Deduping by *description* would be wrong: Vulkan sets
///     the description to the raw device name, which is identical for two
///     identical cards, so a 2x RTX 4090 host would silently collapse to one.
///     A device whose `device_id` is null is kept rather than dropped.
///
/// Returns an empty vector when callers must fall back to CPU.
std::vector<std::string> getSplitDeviceNames(const BackendInterface& bckI);
} // namespace backend_selection
