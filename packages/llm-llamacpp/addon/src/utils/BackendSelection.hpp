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
  void* (*ggml_backend_reg_get_proc_address)(
      ggml_backend_reg_t reg, const char* name);
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

/// @brief Count GPU devices available for multi-GPU split mode.
/// Returns the number of discrete GPUs when any are present; otherwise
/// falls back to the iGPU count. This mirrors backends like Vulkan which
/// exclude iGPUs by default when discrete GPUs exist.
size_t getEffectiveGpuDeviceCount(const BackendInterface& bckI);

/// @brief The ordered device names to hand to `--device` for
/// LLAMA_SPLIT_MODE_TENSOR.
///
/// QVAC-24253. Tensor mode is the one split mode qvac-fabric selects devices
/// for with no type filter and no deduplication: its branch in `src/llama.cpp`
/// keeps everything whose buffer type is not the CPU buffer type, so
/// integrated GPUs are included unconditionally and a physical GPU registered
/// by two backends (e.g. Vulkan and HIP under GGML_BACKEND_DL) is added twice
/// and receives two shards. `layer` and `row` route through fabric's filtered
/// branch and are unaffected, so only tensor mode needs an explicit list.
///
/// Selection mirrors qvac-fabric's own filtered branch (`src/llama.cpp`) so the
/// pinned list matches what fabric would have picked for `layer`/`row`:
///   - RPC devices are excluded. ggml reports them as
///     `GGML_BACKEND_DEVICE_TYPE_GPU` (`ggml-rpc.cpp`, with a TODO), and fabric
///     segregates them precisely so they do not count as discrete GPUs —
///     otherwise the local iGPU is dropped on an iGPU + RPC host. This also
///     matches `emplaceIfValidDevice`, which already skips RPC.
///   - Discrete GPUs when any are present, otherwise the integrated ones.
///   - Duplicates are dropped by `ggml_backend_dev_props::device_id`, the same
///     key fabric uses. Deduping by *description* would be wrong: Vulkan sets
///     the description to the raw device name, which is identical for two
///     identical cards, so a 2x RTX 4090 host would silently collapse to one.
///     A device whose `device_id` is null is kept rather than dropped.
///
/// Returns an empty vector when no GPU device is present; callers must then
/// leave `--device` alone rather than emitting an empty list.
std::vector<std::string>
getTensorSplitDeviceNames(const BackendInterface& bckI);

/// @brief `getTensorSplitDeviceNames()` against the real ggml backend registry.
std::vector<std::string> getTensorSplitDeviceNames();

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
