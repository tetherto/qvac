#pragma once

#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

#include <common/common.h>
#include <common/fit.h>
#include <ggml-backend.h>

namespace model_fit {

using LlamaConfigMap = std::unordered_map<std::string, std::string>;

enum class LlamaLoadKind : uint8_t {
  Completion,
  Embedding,
};

enum class BackendDeviceType : uint8_t {
  Cpu,
  Gpu,
  IntegratedGpu,
  Accelerator,
};

enum class LlamaFitPlatform : uint8_t {
  Desktop,
  Mobile,
};

struct BackendDevice {
  std::string name;
  std::string description;
  BackendDeviceType type = BackendDeviceType::Cpu;
  ggml_backend_dev_t handle = nullptr;
  std::string registryName;
  /// Registry identity, which the iGPU retention rule compares; `registryName`
  /// cannot stand in for it, since two registries may share a name.
  ggml_backend_reg_t registry = nullptr;
  std::string deviceId;
};

struct ModelTraits {
  std::string architecture;
  bool hasOneBitQuantization = false;
};

struct NormalizedLlamaLoad {
  bool supported = true;
  std::string unsupportedDetail;
  common_params params;
  /// A pinned split mode survives a CPU-only plan instead of normalizing to
  /// NONE.
  bool pinsSplitMode = false;
  /// A pinned layer count survives a CPU-only plan. -1 is llama's default and
  /// pins nothing.
  bool pinsGpuLayers = false;
};

struct LlamaLoadFitRequest {
  LlamaLoadKind loadKind = LlamaLoadKind::Completion;
  std::string modelPath;
  LlamaConfigMap params;
  std::string backendsDir;
  uint32_t marginMiB = 1024;
  uint32_t nCtxMin = 0;
};

using LlamaFitInvoker = std::function<common_params_fit_status(
    const char*, llama_model_params*, llama_context_params*, float*,
    llama_model_tensor_buft_override*, size_t*, uint32_t, ggml_log_level)>;
using SupportedLlamaLoadHandler = std::function<void(common_params&)>;

struct LlamaFitExecution {
  common_params_fit_status status = COMMON_PARAMS_FIT_STATUS_ERROR;
  llama_model_params modelParams = llama_model_default_params();
  llama_context_params contextParams = llama_context_default_params();
  std::vector<float> tensorSplit;
  std::vector<llama_model_tensor_buft_override> buftOverrides;
};

std::vector<BackendDevice> discoverBackendDevices();
std::vector<ggml_backend_dev_t> eligibleBackendDeviceHandles(
    const std::vector<BackendDevice>& devices, LlamaLoadKind loadKind);
/// Whether the raw registry entry at `mainGpuIndex` is a supported GPU. The
/// one-device list built for it always places it at ordinal 0.
bool isSupportedGpuOrdinal(
    const std::vector<BackendDevice>& devices, LlamaLoadKind loadKind,
    size_t mainGpuIndex);
/// Pins `storage` as the load's device list and `main_gpu` to ordinal 0 of it,
/// narrowing the list to `mainGpuIndex` when one is given. The caller validates
/// that index with `isSupportedGpuOrdinal`.
void applyBackendDeviceAllowlist(
    llama_model_params& params, std::vector<ggml_backend_dev_t>& storage,
    const std::vector<BackendDevice>& devices,
    std::optional<size_t> mainGpuIndex = std::nullopt);
ModelTraits readModelTraits(const std::string& modelPath);
void validateLlamaLoadFitCriticalIntegers(const LlamaConfigMap& config);
std::optional<std::string>
preBackendUnsupportedLlamaLoad(const LlamaConfigMap& config);
std::optional<std::string> preBackendUnsupportedLlamaLoad(
    const LlamaConfigMap& config, LlamaFitPlatform platform);

NormalizedLlamaLoad normalizeLlamaLoadConfig(
    LlamaLoadKind loadKind, const std::string& modelPath, LlamaConfigMap config,
    const ModelTraits& traits, const std::vector<BackendDevice>& devices);
NormalizedLlamaLoad normalizeLlamaLoadConfig(
    const std::string& modelPath, LlamaConfigMap config,
    const ModelTraits& traits, const std::vector<BackendDevice>& devices);
NormalizedLlamaLoad normalizeLlamaLoadConfig(
    LlamaLoadKind loadKind, const std::string& modelPath, LlamaConfigMap config,
    const ModelTraits& traits, const std::vector<BackendDevice>& devices,
    LlamaFitPlatform platform);
NormalizedLlamaLoad normalizeLlamaLoadConfig(
    const std::string& modelPath, LlamaConfigMap config,
    const ModelTraits& traits, const std::vector<BackendDevice>& devices,
    LlamaFitPlatform platform);

// Applies `embed-llamacpp`'s embedding context rules (pin an unset context to
// the model's trained context, cap an oversized one) to an already-normalized
// load. Split out from `normalizeLlamaLoadConfig`, which never sees the model's
// trained context.
void applyEmbeddingContextPolicy(common_params& params, uint32_t trainedCtx);

LlamaFitExecution invokeLlamaFit(
    const std::string& modelPath, common_params& params, uint32_t marginMiB,
    uint32_t nCtxMin, const LlamaFitInvoker& invoker);
bool withSupportedLlamaLoad(
    NormalizedLlamaLoad& normalized, const SupportedLlamaLoadHandler& handler);

} // namespace model_fit
