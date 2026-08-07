#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <unordered_map>
#include <variant>

#include <llama.h>
#include <inference-addon-cpp/Errors.hpp>

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
  void* (*ggml_backend_reg_get_proc_address)(
      ggml_backend_reg_t reg, const char* name);
  llamaLogCallbackF llamaLogCallback;
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

/// @brief Count GPU devices available for multi-GPU split mode.
/// Returns the number of discrete GPUs when any are present; otherwise
/// falls back to the iGPU count. This mirrors backends like Vulkan which
/// exclude iGPUs by default when discrete GPUs exist.
size_t getEffectiveGpuDeviceCount(const BackendInterface& bckI);

/// @brief Whether row-split (LLAMA_SPLIT_MODE_ROW) can be used at all.
/// True only when at least one GPU device is present AND every available
/// GPU/iGPU device's backend provides split buffers, because qvac-fabric
/// requires split buffers from each device it distributes over and throws on
/// the first one that lacks them. Callers should degrade row -> layer when this
/// returns false. As of qvac-fabric v10069 only SYCL provides split buffers, so
/// this is false in every shipped configuration.
bool gpuBackendSupportsRowSplit(const BackendInterface& bckI);

/// @brief `gpuBackendSupportsRowSplit()` against the real ggml backend
/// registry.
bool gpuBackendSupportsRowSplit();
} // namespace backend_selection
