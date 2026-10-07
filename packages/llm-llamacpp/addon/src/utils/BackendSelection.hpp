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

/// @brief `main-gpu: "cuda:0"`, the nth device of a backend family.
///
/// A bare index depends on backend load order, so adding CUDA moves it. Naming
/// the family makes it stable.
struct MainGpuQualified {
  std::string family;
  int index = 0;
  bool operator==(const MainGpuQualified&) const = default;
};

/// @brief `main-gpu: "0000:65:00.0"` - a PCI bus id, as `props.device_id`.
///
/// The only genuinely stable address: it survives backend order, driver order
/// and adding a card. Meaningless on a backend that publishes no bus id, which
/// is why the numeric and qualified forms remain.
struct MainGpuBusId {
  std::string id;
  bool operator==(const MainGpuBusId&) const = default;
};

using MainGpu = std::variant<int, MainGpuType, MainGpuQualified, MainGpuBusId>;

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

/// @brief Extract and erase `backend-required` (or `backend_required`).
///
/// Makes `backend` binding: a list matching no device throws instead of running
/// the default cascade. Accepts true/on/1, false/off/0. Throws on both
/// spellings, a bad value, or true without `backend`. Default false.
bool tryBackendRequiredFromMap(
    std::unordered_map<std::string, std::string>& configFilemap,
    bool backendOverridePresent);

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
  // QVAC-23763: props.device_id tells one physical card registered under two
  // backends from two distinct cards. Required: getSplitDeviceSelection() and
  // getTensorSplitDeviceNames() call it unconditionally.
  void (*ggml_backend_dev_get_props)(
      ggml_backend_dev_t device, struct ggml_backend_dev_props* props);
  llamaLogCallbackF llamaLogCallback;
  // QVAC-23763: whether @p device can run SET_ROWS writing @p kvType from F32,
  // the op llama_kv_cache builds. Last so positional initialisers compile. Null
  // fails open.
  bool (*deviceSupportsKvCacheType)(
      ggml_backend_dev_t device, enum ggml_type kvType);
};

/// @brief Map a `cache-type-k`/`cache-type-v` value to its ggml_type.
///
/// Returns GGML_TYPE_COUNT when the string names no type. The caller drops that
/// rather than erroring, because tuneLoadConfigMap still validates the value
/// and is the right place for the message.
enum ggml_type kvCacheTypeFromString(const std::string& name);

/// @brief Why a candidate device was passed over.
///
/// Kept per candidate so the trace can say why a higher-priority backend was
/// skipped.
enum class ExclusionReason : std::uint8_t {
  None = 0,
  FinetuneAdrenoBelow800,
  FinetuneAdreno800Plus,
  BitnetAdrenoBelow800,
  BitnetAdreno800Plus,
  /// The device's backend cannot run the requested KV-cache type.
  KvCacheTypeUnsupported,
};

/// @brief What the load requires of a device beyond its being a GPU.
///
/// Default-constructed means no extra constraint.
struct LoadConstraints {
  /// KV-cache types the device must be able to write with SET_ROWS from F32.
  /// Empty when the caller set no cache-type. Non-TBQ/PQ types are present but
  /// always pass the production probe.
  std::vector<enum ggml_type> kvCacheTypes;
  /// When non-empty, every local device used by a split load must belong to
  /// one of these backend families. RPC devices are exempt.
  std::vector<std::string> requiredBackendFamilies;
  /// Set when selection kept a KV-incapable GPU for fabric's per-layer CPU KV
  /// placement. Such devices then also qualify for the split set.
  bool allowCpuKvFallback = false;
};

enum class SelectionPath : std::uint8_t { Cascade, Override, Cpu };

/// @brief The backend family a load actually ran on, as a stable numeric code.
///
/// QVAC-23763: `backendDevice` reports only cpu/gpu, so a silent fallback from
/// one GPU backend to another is invisible in the stats.
///
/// Numeric because RuntimeStats carries `variant<double, int64_t>` and marshals
/// every value through `js::Number::create`; a string would need
/// inference-addon-cpp widened, which is separately published with several
/// consumers. The device *name* therefore stays in the structured log.
///
/// The JS side maps these values back, so append, never renumber.
enum class BackendFamilyCode : std::uint8_t {
  None = 0,
  Cpu = 1,
  Vulkan = 2,
  Cuda = 3,
  Metal = 4,
  OpenCl = 5,
  Rocm = 6,
  Sycl = 7,
  Other = 8,
  Rpc = 9,
};

/// @brief Classify a chosen backend into a @c BackendFamilyCode.
/// @p deviceName is a ggml device name, in any case.
BackendFamilyCode
backendFamilyCodeOf(BackendType type, const std::string& deviceName);

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
  /// When true, a @c backendOverride that matches nothing is an error rather
  /// than a fall-through to the default cascade. QVAC-23763.
  bool backendRequired = false;
  LoadConstraints constraints;
};

/// @brief The chosen backend, plus how it was chosen.
struct BackendChoice {
  BackendType type = BackendType::CPU;
  std::string name = "none";
  std::optional<int> adrenoVersion;
  bool isMaliGpu = false;
  /// The chosen GPU cannot run the requested KV type and relies on fabric's
  /// per-layer CPU KV placement.
  bool cpuKvFallback = false;
  SelectionTrace trace;
};

BackendChoice
chooseBackend(const BackendRequest& request, const BackendInterface& bckI);

/// @brief `chooseBackend()` against the real ggml backend registry.
BackendChoice chooseBackend(
    const BackendRequest& request, llamaLogCallbackF llamaLogcallback);

struct SplitDevice {
  std::string name;
  std::string registry;
  ggml_backend_dev_t handle = nullptr;
  size_t sourceGpuIndex = 0;
  bool isRpc = false;
  std::optional<int> adrenoVersion;
  bool isOpenCl = false;
  bool isMetal = false;
  std::string deviceId;
};

struct SplitDeviceSelection {
  std::vector<SplitDevice> devices;
  size_t sourceGpuCount = 0;
  std::vector<std::string> rejectedDevices;
  bool heterogeneous = false;
  // Discrete devices left out as a possible twin of a kept one, so the same
  // card is not split across two backends. An explicit `devices` list may
  // still name them.
  std::vector<SplitDevice> dedupedTwins;
  // The subset dropped only because a twin could not be ruled out, with no
  // device id to compare. The caller warns about them.
  std::vector<std::string> droppedAmbiguousDevices;
};

SplitDeviceSelection getSplitDeviceSelection(const BackendInterface& bckI);
SplitDeviceSelection getSplitDeviceSelection();

/// @brief The authoritative split set after applying load constraints and
/// preferring the selected backend when one physical GPU has multiple backend
/// registrations.
SplitDeviceSelection getSplitDeviceSelection(
    const BackendInterface& bckI, const std::string& selectedDeviceName,
    const LoadConstraints& constraints);
SplitDeviceSelection getSplitDeviceSelection(
    const std::string& selectedDeviceName, const LoadConstraints& constraints);

void applyAdrenoRestrictions(
    SplitDeviceSelection& selection, const ModelMetaData& metadata,
    bool isFinetuning);

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

/// @brief Count devices in the final Fabric-compatible split set, that is
/// `getSplitDeviceSelection(bckI).devices.size()`.
size_t getEffectiveGpuDeviceCount(const BackendInterface& bckI);

/// @brief The ordered, constraint-filtered device names that
/// getSplitDeviceSelection(selectedDeviceName, constraints) keeps, for every
/// split mode.
///
/// QVAC-24253. Tensor mode is the one split mode qvac-fabric selects devices
/// for with no type filter and no deduplication: its branch in `src/llama.cpp`
/// keeps everything whose buffer type is not the CPU buffer type, so
/// integrated GPUs are included unconditionally and a physical GPU registered
/// by two backends (e.g. Vulkan and HIP under GGML_BACKEND_DL) is added twice
/// and receives two shards. Tensor mode therefore always needs an explicit
/// list.
///
/// Selection mirrors qvac-fabric's own filtered branch (`src/llama.cpp`) so the
/// pinned list matches what fabric would have picked for `layer`/`row`:
///   - RPC devices are excluded. ggml reports them as
///     `GGML_BACKEND_DEVICE_TYPE_GPU` (`ggml-rpc.cpp`, with a TODO), and fabric
///     segregates them precisely so they do not count as discrete GPUs;
///     otherwise the local iGPU is dropped on an iGPU + RPC host. The
///     authoritative handle-based split selection adds RPC devices separately.
///   - Discrete GPUs when any are present, otherwise the integrated ones.
///   - Duplicates are dropped by `ggml_backend_dev_props::device_id`, the same
///     key fabric uses. Deduping by *description* would be wrong: Vulkan sets
///     the description to the raw device name, which is identical for two
///     identical cards, so a 2x RTX 4090 host would silently collapse to one.
///     A device whose `device_id` is null is kept rather than dropped.
///   - Devices that cannot meet @p constraints are excluded, and duplicate
///     representations prefer @p selectedDeviceName's registry.
///
/// Returns an empty vector when no GPU device is present.
/// `droppedAmbiguous`, when set, receives the devices left out because an
/// id-less copy of one card could not be ruled out across registries.
std::vector<std::string> getTensorSplitDeviceNames(
    const BackendInterface& bckI, const std::string& selectedDeviceName = {},
    const LoadConstraints& constraints = {},
    std::vector<std::string>* droppedAmbiguous = nullptr);

/// @brief `getTensorSplitDeviceNames()` against the real ggml backend registry.
std::vector<std::string> getTensorSplitDeviceNames(
    const std::string& selectedDeviceName = {},
    const LoadConstraints& constraints = {});

/// @brief The names of getSplitDeviceSelection()'s devices, in order.
std::vector<std::string> getSplitDeviceNames(const BackendInterface& bckI);

/// @brief Whether row-split (LLAMA_SPLIT_MODE_ROW) can be used at all.
/// True only when at least one GPU device is present AND every available
/// GPU/iGPU device's backend provides split buffers, because qvac-fabric
/// requires split buffers from each device it distributes over and throws on
/// the first one that lacks them. No production caller: split-mode 'row' is
/// rejected at config time. As of qvac-fabric v11018 only SYCL and Hexagon
/// provide split buffers, and the port builds neither, so this is false in
/// every shipped configuration.
bool gpuBackendSupportsRowSplit(const BackendInterface& bckI);

/// @brief `gpuBackendSupportsRowSplit()` against the real ggml backend
/// registry.
bool gpuBackendSupportsRowSplit();

/// @brief `splitModeDeviceNames()` plus each device's registry.
///
/// QVAC-23763: records whether the split spans more than one registry. No
/// production caller yet; the user-facing warning reads
/// @c SplitDeviceSelection::heterogeneous.
struct SplitDeviceList {
  std::vector<std::string> names;
  /// Parallel to @c names.
  std::vector<std::string> registries;
  /// True when @c names spans more than one registry.
  bool heterogeneous = false;
};

SplitDeviceList splitModeDeviceNamesDetailed(
    const BackendInterface& bckI, const std::string& selectedDeviceName,
    const LoadConstraints& constraints = {});

/// @brief The local device names a multi-GPU split load pins: every
/// discrete GPU, deduplicated by `props.device_id` so a card registered under
/// two backends is named once, preferring @p selectedDeviceName's registry.
///
/// QVAC-23763: one NVIDIA card registers as both CUDA0 and Vulkan0. Empty when
/// every usable GPU/iGPU device comes from one registry, none was excluded by
/// @p constraints and no backend family is required, or when
/// @p selectedDeviceName matches nothing.
std::vector<std::string> splitModeDeviceNames(
    const BackendInterface& bckI, const std::string& selectedDeviceName,
    const LoadConstraints& constraints = {});

/// @brief `splitModeDeviceNames()` against the real ggml backend registry.
std::vector<std::string> splitModeDeviceNames(
    const std::string& selectedDeviceName,
    const LoadConstraints& constraints = {});

/// @brief `splitModeDeviceNamesDetailed()` against the real ggml registry.
SplitDeviceList splitModeDeviceNamesDetailed(
    const std::string& selectedDeviceName,
    const LoadConstraints& constraints = {});

/// @brief Inputs to the CUDA PTX JIT cache check, gathered from the
/// environment so the policy below stays testable.
struct JitCacheEnv {
  bool cacheDisabled = false; ///< CUDA_CACHE_DISABLE is set to something truthy
  bool haveCacheDir = false;  ///< a cache directory could be resolved at all
  bool cacheDirWritable = false; ///< that directory, or its nearest existing
                                 ///< ancestor, passes a write check
};

/// @brief Whether to warn that CUDA will re-JIT its kernels on every start.
///
/// QVAC-24470: a device with no `-real` cubin in the build reaches the kernels
/// by JITting the `-virtual` PTX, and the driver caches the result under
/// `$HOME/.nv/ComputeCache`. Measured on a DGX Spark at sm_121, before the
/// build shipped a 121a-real cubin: 27.3 s to first token cold against 143.9 ms
/// warm. Where that cache cannot persist, a container with no writable `$HOME`
/// being the usual case, the full cost is paid on every process start.
///
/// It is not a crash, so no backend guard catches it, and to a user it is
/// indistinguishable from a hang. Warning is all this can do; removing the cost
/// means shipping a `-real` cubin for the architecture.
bool shouldWarnAboutJitCache(const JitCacheEnv& env);

/// @brief `shouldWarnAboutJitCache()` against the real environment. Always
/// false off Linux; the Windows cache check is not implemented.
bool shouldWarnAboutJitCache();
} // namespace backend_selection
