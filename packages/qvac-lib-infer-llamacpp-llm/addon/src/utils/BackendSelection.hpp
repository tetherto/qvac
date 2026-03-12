#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <unordered_map>
#include <variant>

#include <llama.h>
#include <qvac-lib-inference-addon-cpp/Errors.hpp>

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
  llamaLogCallbackF llamaLogCallback;
};

std::pair<BackendType, std::string> chooseBackend(
    BackendType preferredBackendType, const BackendInterface& bckI,
    const ModelMetaData* metadata = nullptr,
    const std::optional<MainGpu>& mainGpu = std::nullopt,
    std::optional<int>* outAdrenoVersion = nullptr, bool isFinetuning = false);

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
std::pair<BackendType, std::string> chooseBackend(
    BackendType preferredBackendType, llamaLogCallbackF llamaLogcallback,
    const std::optional<MainGpu>& mainGpu, const ModelMetaData* metadata,
    std::optional<int>* outAdrenoVersion = nullptr, bool isFinetuning = false);
} // namespace backend_selection
