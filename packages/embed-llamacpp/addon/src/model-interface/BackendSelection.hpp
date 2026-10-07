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
  void* (*ggml_backend_reg_get_proc_address)(
      ggml_backend_reg_t reg, const char* name);
  // QVAC-23763: props.device_id tells one physical card registered under two
  // backends from two distinct cards. Required: getSplitDeviceSelection() calls
  // it unconditionally.
  void (*ggml_backend_dev_get_props)(
      ggml_backend_dev_t device, struct ggml_backend_dev_props* props);
  llamaLogCallbackF llamaLogCallback;
  // QVAC-23763: KV-cache capability probe. Left null in embed because it has no
  // cache-type config. Null fails open, so whoever adds cache-type support must
  // set it. Last so positional initialisers compile.
  bool (*deviceSupportsKvCacheType)(
      ggml_backend_dev_t device, enum ggml_type kvType);
};

/// @brief Why a candidate device was passed over.
///
/// QVAC-23763: embed sets only None today.
enum class ExclusionReason : std::uint8_t {
  None = 0,
  KvCacheTypeUnsupported,
};

enum class ExclusionKind : std::uint8_t { PreferOther, Incapable };

/// Total by construction: a new ExclusionReason must be classified here.
ExclusionKind kindOf(ExclusionReason reason);

/// @brief What the load requires of a device beyond its being a GPU.
struct LoadConstraints {
  std::vector<enum ggml_type> kvCacheTypes;
};

enum class SelectionPath : std::uint8_t { Cascade, Override, Cpu };

/// @brief How the choice was reached, and what it beat.
struct SelectionTrace {
  std::string selectedName;
  std::string selectedRegistry;
  SelectionPath path = SelectionPath::Cpu;
  std::string skippedName;
  std::string skippedRegistry;
  ExclusionReason skippedReason = ExclusionReason::None;
};

/// @brief Everything selection needs to know about the caller's intent.
struct BackendRequest {
  BackendType preferred = BackendType::CPU;
  std::optional<MainGpu> mainGpu;
  std::vector<std::string> backendOverride;
  LoadConstraints constraints;
};

/// @brief The chosen backend, plus how it was chosen.
struct BackendChoice {
  BackendType type = BackendType::CPU;
  std::string name = "none";
  SelectionTrace trace;
};

BackendChoice
chooseBackend(const BackendRequest& request, const BackendInterface& bckI);

struct SplitDevice {
  std::string name;
  ggml_backend_dev_t handle = nullptr;
  size_t sourceGpuIndex = 0;
  bool isOpenCl = false;
  bool isRpc = false;
};

struct SplitDeviceSelection {
  std::vector<SplitDevice> devices;
  size_t sourceGpuCount = 0;
  std::vector<std::string> rejectedDevices;
  // Discrete devices dropped because a twin of one card could not be ruled
  // out across backends, with no device id to compare. The caller warns.
  std::vector<std::string> droppedAmbiguousDevices;
};

SplitDeviceSelection getSplitDeviceSelection(const BackendInterface& bckI);
SplitDeviceSelection getSplitDeviceSelection();
std::vector<std::string> getSplitDeviceNames(const BackendInterface& bckI);

/// @brief Adapter for the positional form. Retained so existing callers and
/// tests are unaffected by the request/choice split; prefer the overload above
/// for new code.
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

/// @brief Count devices in the final Fabric-compatible split set, that is
/// `getSplitDeviceSelection(bckI).devices.size()`.
size_t getEffectiveGpuDeviceCount(const BackendInterface& bckI);

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

/// @brief Device names for split mode, preferring the selected backend when
/// one physical GPU is registered by more than one backend.
/// No production caller yet.
std::vector<std::string> splitModeDeviceNames(
    const BackendInterface& bckI, const std::string& selectedDeviceName);

/// @brief `splitModeDeviceNames()` against the real ggml backend registry.
std::vector<std::string>
splitModeDeviceNames(const std::string& selectedDeviceName);
} // namespace backend_selection
