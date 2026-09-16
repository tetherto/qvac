#pragma once

#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <unordered_map>
#include <variant>
#include <vector>

#include <common/common.h>

#include "model-interface/ModelMetadata.hpp"
#include "utils/BackendSelection.hpp"

struct FinetuneConfigOverrides {
  bool active{false};
  int64_t batchSize{128};
  int64_t microBatchSize{128};
  int64_t contextLength{128};
  bool gpuSupportsF16OutProd{true};
  bool flashAttn{false};
};

namespace load_fit_normalization {

using ConfigMap = std::unordered_map<std::string, std::string>;

struct CanonicalTensorBufferOverride {
  std::string pattern;
  std::string bufferType;
  bool operator==(const CanonicalTensorBufferOverride&) const = default;
};

using CanonicalModelKvValue = std::variant<int64_t, double, bool, std::string>;

struct CanonicalModelKvOverride {
  std::string key;
  int32_t type = 0;
  CanonicalModelKvValue value = int64_t{0};
  bool operator==(const CanonicalModelKvOverride&) const = default;
};

struct NormalizedFitSnapshot {
  int32_t nGpuLayers = 0;
  uint32_t nCtx = 0;
  uint32_t nBatch = 0;
  uint32_t nUbatch = 0;
  uint32_t nParallel = 0;
  int32_t splitMode = 0;
  int32_t mainGpu = 0;
  std::vector<float> tensorSplit;
  int32_t typeK = 0;
  int32_t typeV = 0;
  int32_t flashAttnType = 0;
  bool useMmap = true;
  bool useMlock = false;
  bool kvOffload = true;
  bool opOffload = true;
  bool swaFull = false;
  bool kvUnified = false;
  bool useExtraBufferTypes = true;
  bool useHostBuffer = true;
  bool fitParams = true;
  int32_t fitParamsMinCtx = 4096;
  std::vector<uint64_t> fitParamsTargetBytes;
  std::vector<CanonicalModelKvOverride> modelKvOverrides;
  std::vector<CanonicalTensorBufferOverride> tensorBufferOverrides;
  bool operator==(const NormalizedFitSnapshot&) const = default;
};

struct SelectedBackend {
  backend_selection::BackendType type = backend_selection::BackendType::CPU;
  std::string name = "none";
  std::optional<int> adrenoVersion;
  bool isMaliGpu = false;
  bool isOpenCl = false;
  bool isMetal = false;
};

using BackendResolver = std::function<SelectedBackend(
    backend_selection::BackendType,
    const std::optional<backend_selection::MainGpu>&, const ModelMetaData&,
    bool)>;

/// Resolves a backend device *name* to a handle that can be pinned, or nullptr
/// if this host has no such device or the one it has is a CPU device.
///
/// `split-mode: none` is the only branch that has a name and no handle — every
/// multi-GPU mode gets handles from `splitDevices` — so it used to hand the
/// name to qvac-fabric as `--device <name>` and let `parse_device_list`
/// (common/arg.cpp) do the lookup. That put a live ggml registry between the
/// test and the policy under test: the whole branch was unreachable on any host
/// without the exact GPU named. Resolving here instead keeps the same rejection
/// rule and makes the boundary injectable.
using DeviceResolver = std::function<ggml_backend_dev_t(const std::string&)>;

struct NormalizationDependencies {
  BackendResolver resolveBackend;
  /// Authoritative eligible device set for every multi-GPU split mode.
  std::function<backend_selection::SplitDeviceSelection()> splitDevices;
  /// Name-to-handle lookup for `split-mode: none`. Defaulted so existing
  /// callers and tests that pin by handle need not supply one.
  DeviceResolver resolveDeviceByName;
};

struct NormalizedLoad {
  common_params params;
  NormalizedFitSnapshot fitSnapshot;
  std::optional<int> adrenoVersion;
  int64_t runtimeBackendDevice = 0;
};

NormalizationDependencies
productionDependencies(backend_selection::llamaLogCallbackF logCallback);

NormalizedFitSnapshot
makeNormalizedFitSnapshot(const common_params& params, uint32_t trainedContext);

void tuneLoadConfigMap(
    ConfigMap& configFilemap, const ModelMetaData& metadata,
    const std::optional<int>& adrenoVersion,
    const FinetuneConfigOverrides& finetuneOverrides = {},
    bool isOpenCl = false, bool isMetal = false, bool isGpu = false,
    bool isTensorSplit = false);

NormalizedLoad normalizeLoadForFit(
    const std::string& modelPath, ConfigMap configFilemap,
    const ModelMetaData& metadata,
    const FinetuneConfigOverrides& finetuneOverrides,
    const NormalizationDependencies& dependencies);

} // namespace load_fit_normalization
