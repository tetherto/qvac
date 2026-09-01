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
  // QVAC-23763: splitModeDeviceNames() needs props.device_id to tell one
  // physical card registered under two backends from two distinct cards. May
  // be null; that path then falls back to scoping by registry.
  void (*ggml_backend_dev_get_props)(
      ggml_backend_dev_t device, struct ggml_backend_dev_props* props);
  llamaLogCallbackF llamaLogCallback;
  // QVAC-23763: whether @p device can run the op a KV cache of @p kvType needs,
  // which is SET_ROWS writing kvType from F32 - exactly what llama_kv_cache
  // builds, and exactly what a backend's supports_op table answers. Asking ggml
  // the capability question beats matching the device name against "cuda",
  // because the answer then corrects itself when a backend gains those kernels.
  //
  // Deliberately last so existing positional initialisers keep compiling. Null
  // means "unknown" and fails OPEN - no exclusion, pre-QVAC-23763 behaviour - so
  // an initialiser that omits it stays correct, just unfiltered.
  bool (*deviceSupportsKvCacheType)(
      ggml_backend_dev_t device, enum ggml_type kvType);
};

/// @brief Map a `cache-type-k`/`cache-type-v` value to its ggml_type.
///
/// Returns GGML_TYPE_COUNT when the string names no type. The caller drops that
/// rather than erroring, because tuneLoadConfigMap still validates the value and
/// is the right place for the message.
enum ggml_type kvCacheTypeFromString(const std::string& name);

/// @brief Why a candidate device was passed over.
///
/// QVAC-23763: selection used to express these by clearing whole buckets, which
/// destroyed the reason along with the candidate. Keeping the reason is what
/// lets the caller say *why* a higher-priority backend was not chosen.
enum class ExclusionReason : std::uint8_t {
  None = 0,
  FinetuneAdrenoBelow800,
  FinetuneAdreno800Plus,
  BitnetAdrenoBelow800,
  BitnetAdreno800Plus,
};

/// @brief Whether landing on CPU because every GPU carries this reason is an
/// acceptable outcome or an error.
///
/// PreferOther means the guard actively wants another backend, and CPU is a
/// legitimate destination - this is every Adreno/BitNet/finetune rule, and
/// falling to CPU is what they already do. Incapable means the device cannot run
/// the load at all; if nothing else can either, that is worth failing over
/// rather than silently running somewhere far slower than the caller asked for.
enum class ExclusionKind : std::uint8_t { PreferOther, Incapable };

/// Total by construction: a new ExclusionReason must be classified before this
/// compiles.
ExclusionKind kindOf(ExclusionReason reason);

/// @brief What the load requires of a device beyond its being a GPU.
///
/// Default-constructed means no extra constraint, which is every pre-QVAC-23763
/// caller.
struct LoadConstraints {
  /// Reserved for the KV-cache-type capability filter. Empty today.
  std::vector<ggml_type> kvCacheTypes;
};

enum class SelectionPath : std::uint8_t { Cascade, Override, Cpu };

/// @brief How the choice was reached, and what it beat.
struct SelectionTrace {
  std::string selectedName;
  std::string selectedRegistry;
  SelectionPath path = SelectionPath::Cpu;
  /// The highest-priority candidate that was passed over, and why. Empty when
  /// nothing was passed over.
  std::string skippedName;
  std::string skippedRegistry;
  ExclusionReason skippedReason = ExclusionReason::None;
};

/// @brief Everything selection needs to know about the caller's intent.
struct BackendRequest {
  BackendType preferred = BackendType::CPU;
  const ModelMetaData* metadata = nullptr;
  std::optional<MainGpu> mainGpu;
  bool isFinetuning = false;
  std::vector<std::string> backendOverride;
  LoadConstraints constraints;
};

/// @brief The chosen backend, plus how it was chosen.
struct BackendChoice {
  BackendType type = BackendType::CPU;
  std::string name = "none";
  std::optional<int> adrenoVersion;
  bool isMaliGpu = false;
  SelectionTrace trace;
};

BackendChoice chooseBackend(
    const BackendRequest& request, const BackendInterface& bckI);

/// @brief Adapter for the positional form. Retained so existing callers and
/// tests are unaffected by the request/choice split; prefer the overload above
/// for new code.
std::pair<BackendType, std::string> chooseBackend(
    BackendType preferredBackendType, const BackendInterface& bckI,
    const ModelMetaData* metadata = nullptr,
    const std::optional<MainGpu>& mainGpu = std::nullopt,
    std::optional<int>* outAdrenoVersion = nullptr, bool isFinetuning = false,
    bool* outIsMaliGpu = nullptr,
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
    bool* outIsMaliGpu = nullptr,
    const std::vector<std::string>& backendOverride = {});

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

/// @brief The device names to pass as `--device` in multi-GPU split mode: every
/// discrete GPU, deduplicated by `props.device_id` so a card registered under
/// two backends is named once, preferring @p selectedDeviceName's registry.
///
/// QVAC-23763: with CUDA loaded next to Vulkan, one physical NVIDIA card
/// registers twice, as CUDA0 and Vulkan0, so the old unconditional omission of
/// `--device` would spread a single card across two backends. Deduping rather
/// than scoping to one registry keeps a second physical card on a mixed-vendor
/// host, and preferring the selected registry keeps a `backend` override
/// binding, which omitting `--device` would not.
///
/// A device whose backend publishes no bus id falls back to registry scoping,
/// since it cannot be matched against its own duplicate.
///
/// Empty when every GPU/iGPU device comes from one registry, which is every
/// pre-CUDA configuration, and when @p selectedDeviceName matches nothing. The
/// caller then keeps omitting `--device`.
std::vector<std::string> splitModeDeviceNames(
    const BackendInterface& bckI, const std::string& selectedDeviceName);

/// @brief `splitModeDeviceNames()` against the real ggml backend registry.
std::vector<std::string>
splitModeDeviceNames(const std::string& selectedDeviceName);
} // namespace backend_selection
