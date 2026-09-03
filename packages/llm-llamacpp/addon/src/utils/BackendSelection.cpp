#include "BackendSelection.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <charconv>
#include <optional>
#include <regex>
#include <string_view>
#include <unordered_set>
#include <variant>
#include <vector>

#include <common/log.h>
#include <ggml-backend.h>

#include "common/common.h"
#include "model-interface/ModelMetadata.hpp"

using namespace backend_selection;

namespace {

constexpr std::array<std::string_view, 6> SUPPORTED_FINETUNE_ARCHITECTURES = {
    "gemma3", "qwen3", "bitnet", "qwen35", "qwen35moe", "gemma4"};

bool isSupportedFinetuneArchitecture(std::string_view arch) {
  return std::ranges::find(SUPPORTED_FINETUNE_ARCHITECTURES, arch) !=
         SUPPORTED_FINETUNE_ARCHITECTURES.end();
}

} // namespace

std::optional<std::string> backend_selection::getUnknownFinetuneArchitecture(
    const ModelMetaData* metadata) {
  const auto arch = metadata != nullptr
                        ? metadata->tryGetString("general.architecture")
                        : std::nullopt;
  if (arch.has_value() && isSupportedFinetuneArchitecture(arch.value())) {
    return std::nullopt;
  }
  return arch.value_or("unknown");
}

namespace {

std::optional<int> parseAdrenoVersion(const std::string& gpuDescription) {
  static const std::regex adrenoRegex(R"(dreno.*?(\d+))");
  std::smatch matches;
  if (std::regex_search(gpuDescription, matches, adrenoRegex) &&
      matches.size() > 1) {
    try {
      return std::stoi(matches[1].str());
    } catch (const std::exception& e) {
      LOG_WRN(
          "parseAdrenoVersion: failed to parse version from '%s': %s\n",
          gpuDescription.c_str(),
          e.what());
    }
  }
  return std::nullopt;
}

struct DeviceDescription {
  std::string gpuDescription;
  std::string gpuBackend;

  DeviceDescription(
      const ggml_backend_dev_t dev,
      const enum ggml_backend_dev_type backendTypeEnum,
      const BackendInterface& bckI)
      : gpuDescription(bckI.ggml_backend_dev_description(dev)),
        gpuBackend(bckI.ggml_backend_dev_name(dev)) {
    std::transform(
        gpuDescription.begin(),
        gpuDescription.end(),
        gpuDescription.begin(),
        tolower);
    std::transform(
        gpuBackend.begin(), gpuBackend.end(), gpuBackend.begin(), tolower);
    {
      std::string backendTypeStr;
      switch (backendTypeEnum) {
      case GGML_BACKEND_DEVICE_TYPE_CPU:
        backendTypeStr = "CPU";
        break;
      case GGML_BACKEND_DEVICE_TYPE_GPU:
        backendTypeStr = "GPU";
        break;
      case GGML_BACKEND_DEVICE_TYPE_IGPU:
        backendTypeStr = "IGPU";
        break;
      case GGML_BACKEND_DEVICE_TYPE_ACCEL:
        backendTypeStr = "ACCEL";
        break;
      default:
        backendTypeStr = "unknownEnum";
        break;
      }
      std::string text = string_format(
          "Backend detected: description = %s, backend = %s, type = %s",
          gpuDescription.c_str(),
          gpuBackend.c_str(),
          backendTypeStr.c_str());
      bckI.llamaLogCallback(GGML_LOG_LEVEL_INFO, text.c_str(), nullptr);
    }
  }
};

// Defined below, next to the family list it matches against. Forward-declared
// because enumerateCandidates() needs it to resolve a `main-gpu` like "cuda:0".
bool backendNameMatchesFamily(
    const std::string& lowercasedBackendName, std::string_view family);

// QVAC-23763: one candidate list with a family tag, rather than five buckets.
// Selection needs to pass a device over *and remember why*, which clearing a
// bucket cannot express - see ExclusionReason in the header.
enum class DeviceFamily : std::uint8_t {
  OpenClAdreno,
  OpenClOther,
  Cuda,
  Gpu,
  Igpu,
};

struct Candidate {
  std::string name;
  std::string registry;
  DeviceFamily family = DeviceFamily::Gpu;
  /// Kept so a capability probe can be run against the device itself rather
  /// than inferred from its name.
  ggml_backend_dev_t dev = nullptr;
  backend_selection::ExclusionReason excluded =
      backend_selection::ExclusionReason::None;
};

struct Enumeration {
  /// ggml enumeration order, preserved: first-registered wins within a family.
  std::vector<Candidate> candidates;
  std::optional<int> maxAdrenoVersion;
  bool sawMaliGpu = false;
};

void emplaceIfValidDevice(
    const BackendInterface& bckI, Enumeration& out, const ggml_backend_dev_t dev,
    const ggml_backend_reg_t reg, const DeviceDescription& devDescr,
    const enum ggml_backend_dev_type backendTypeEnum) {
  if (bckI.ggml_backend_reg_name(reg) == std::string("RPC")) {
    return;
  }

  auto logEmplaceGpuBackend = [&](const std::string& gpuBackend) {
#ifndef NDEBUG
    std::string text = string_format(
        "Emplacing backend: gpuBackend = %s", gpuBackend.c_str());
    bckI.llamaLogCallback(GGML_LOG_LEVEL_INFO, text.c_str(), nullptr);
#else
    (void) gpuBackend;
#endif
  };

  const bool isOpenCl = devDescr.gpuBackend.find("opencl") != std::string::npos;
  const bool isAdreno =
      devDescr.gpuDescription.find("dreno") != std::string::npos;
  // QVAC-21867: track Mali GPUs (description is lowercased by
  // DeviceDescription) so callers can pick per-device-class defaults for
  // the multimodal projector backend.
  if (devDescr.gpuDescription.find("mali") != std::string::npos) {
    out.sawMaliGpu = true;
  }
  if (isAdreno) {
    auto version = parseAdrenoVersion(devDescr.gpuDescription);
    if (version.has_value() &&
        (!out.maxAdrenoVersion.has_value() ||
         version.value() > out.maxAdrenoVersion.value())) {
      out.maxAdrenoVersion = version;
    }
  }
  // QVAC-23763: ggml-cuda names its devices "CUDA%d". ggml-hip reports
  // "ROCm%d" instead, so this cannot collide with an AMD device.
  const bool isCuda = devDescr.gpuBackend.find("cuda") != std::string::npos;

  logEmplaceGpuBackend(devDescr.gpuBackend);

  std::optional<DeviceFamily> family;
  if (isOpenCl && isAdreno) {
    family = DeviceFamily::OpenClAdreno;
  } else if (isOpenCl) {
    // QVAC-23763: a non-Adreno OpenCL device is deliberately kept out of the
    // default cascade, which is Adreno-tuned. It gets its own family so an
    // explicit backend:'opencl' can still reach it, instead of `opencl` being
    // an accepted family that matches nothing on an Intel or AMD host.
    family = DeviceFamily::OpenClOther;
  } else if (isCuda && backendTypeEnum == GGML_BACKEND_DEVICE_TYPE_GPU) {
    family = DeviceFamily::Cuda;
  } else if (backendTypeEnum == GGML_BACKEND_DEVICE_TYPE_GPU) {
    family = DeviceFamily::Gpu;
  } else if (backendTypeEnum == GGML_BACKEND_DEVICE_TYPE_IGPU) {
    family = DeviceFamily::Igpu;
  }
  // Anything else - an ACCEL device, say - is logged but is not a candidate,
  // matching the pre-QVAC-23763 bucketing.
  if (!family.has_value()) {
    return;
  }

  out.candidates.push_back(Candidate{
      devDescr.gpuBackend,
      bckI.ggml_backend_reg_name(reg),
      family.value(),
      dev,
      backend_selection::ExclusionReason::None});
}

bool shouldProcessDevice(
    const enum ggml_backend_dev_type backendTypeEnum,
    const DeviceDescription& devDescr,
    const std::optional<MainGpuType> mainGpuType) {
  const bool anyGpu = !mainGpuType.has_value() &&
                      (backendTypeEnum == GGML_BACKEND_DEVICE_TYPE_GPU ||
                       backendTypeEnum == GGML_BACKEND_DEVICE_TYPE_IGPU);
  const bool integratedGpu = mainGpuType.has_value() &&
                             mainGpuType.value() == MainGpuType::Integrated &&
                             backendTypeEnum == GGML_BACKEND_DEVICE_TYPE_IGPU;
  const bool dedicatedGpu = mainGpuType.has_value() &&
                            mainGpuType.value() == MainGpuType::Dedicated &&
                            backendTypeEnum == GGML_BACKEND_DEVICE_TYPE_GPU;
  const bool isOpenCl = devDescr.gpuBackend.find("opencl") != std::string::npos;
  return anyGpu || integratedGpu || dedicatedGpu || isOpenCl;
}

void tryEmplaceDevice(
    const BackendInterface& bckI, size_t deviceIndex,
    std::optional<MainGpuType> mainGpuType, Enumeration& out) {
  const ggml_backend_dev_t dev = bckI.ggml_backend_dev_get(deviceIndex);
  const ggml_backend_reg_t reg = bckI.ggml_backend_dev_backend_reg(dev);
  const enum ggml_backend_dev_type backendTypeEnum =
      bckI.ggml_backend_dev_type(dev);
  const DeviceDescription devDescr(dev, backendTypeEnum, bckI);
  if (shouldProcessDevice(backendTypeEnum, devDescr, mainGpuType)) {
#ifndef NDEBUG
    bckI.llamaLogCallback(GGML_LOG_LEVEL_INFO, "New GPU device", nullptr);
#endif
    ::emplaceIfValidDevice(bckI, out, dev, reg, devDescr, backendTypeEnum);
  } else {
#ifndef NDEBUG
    bckI.llamaLogCallback(
        GGML_LOG_LEVEL_INFO, "Non-GPU type of device", nullptr);
#endif
  }
}

/// Resolve a backend-qualified or bus-id `main-gpu` to a device index.
///
/// Scans rather than indexes: that is what makes these forms stable against
/// backend load order. Returns nullopt and warns when nothing matches, so the
/// caller can fall through to the full enumeration.
std::optional<size_t> resolveNamedMainGpu(
    const BackendInterface& bckI, const MainGpu& mainGpuValue) {
  const size_t deviceCount = bckI.ggml_backend_dev_count();

  if (std::holds_alternative<MainGpuQualified>(mainGpuValue)) {
    const MainGpuQualified& want = std::get<MainGpuQualified>(mainGpuValue);
    int seen = 0;
    for (size_t i = 0; i < deviceCount; ++i) {
      const ggml_backend_dev_t dev = bckI.ggml_backend_dev_get(i);
      std::string name = bckI.ggml_backend_dev_name(dev);
      std::ranges::transform(name, name.begin(), ::tolower);
      if (!::backendNameMatchesFamily(name, want.family)) {
        continue;
      }
      if (seen == want.index) {
        return i;
      }
      ++seen;
    }
    std::string msg = string_format(
        "main-gpu '%s:%d' matched no device (%d %s device(s) present); using "
        "the default device order instead",
        want.family.c_str(),
        want.index,
        seen,
        want.family.c_str());
    bckI.llamaLogCallback(GGML_LOG_LEVEL_WARN, msg.c_str(), nullptr);
    return std::nullopt;
  }

  const MainGpuBusId& want = std::get<MainGpuBusId>(mainGpuValue);
  if (bckI.ggml_backend_dev_get_props == nullptr) {
    bckI.llamaLogCallback(
        GGML_LOG_LEVEL_WARN,
        "main-gpu was given a PCI bus id, but this build cannot read device bus "
        "ids; using the default device order instead",
        nullptr);
    return std::nullopt;
  }
  for (size_t i = 0; i < deviceCount; ++i) {
    const ggml_backend_dev_t dev = bckI.ggml_backend_dev_get(i);
    ggml_backend_dev_props props{};
    bckI.ggml_backend_dev_get_props(dev, &props);
    if (props.device_id == nullptr) {
      continue;
    }
    std::string id = props.device_id;
    std::ranges::transform(id, id.begin(), ::tolower);
    if (id == want.id) {
      return i;
    }
  }
  std::string msg = string_format(
      "main-gpu bus id '%s' matched no device; using the default device order "
      "instead",
      want.id.c_str());
  bckI.llamaLogCallback(GGML_LOG_LEVEL_WARN, msg.c_str(), nullptr);
  return std::nullopt;
}

/// Every device the request makes eligible, in ggml enumeration order.
Enumeration enumerateCandidates(
    const BackendInterface& bckI, const backend_selection::BackendRequest& req) {
  Enumeration out;
  if (req.preferred != BackendType::GPU) {
    return out;
  }

  bool loopAllDevices = true;
  std::optional<MainGpuType> gpuType = std::nullopt;
  if (req.mainGpu.has_value()) {
    const MainGpu& mainGpuValue = req.mainGpu.value();
    if (std::holds_alternative<int>(mainGpuValue)) {
      const int deviceIndex = std::get<int>(mainGpuValue);
      const size_t deviceCount = bckI.ggml_backend_dev_count();
      if (deviceIndex >= 0 && static_cast<size_t>(deviceIndex) < deviceCount) {
        ::tryEmplaceDevice(
            bckI, static_cast<size_t>(deviceIndex), std::nullopt, out);
        loopAllDevices = false;
      } else {
        std::string errorMsg;
        if (deviceCount == 0) {
          errorMsg = string_format(
              "main-gpu device index %d is out of range: no devices are "
              "available",
              deviceIndex);
        } else {
          errorMsg = string_format(
              "main-gpu device index %d is out of range (0-%zu)",
              deviceIndex,
              deviceCount - 1);
        }
        bckI.llamaLogCallback(GGML_LOG_LEVEL_WARN, errorMsg.c_str(), nullptr);
      }
    } else if (std::holds_alternative<MainGpuType>(mainGpuValue)) {
      gpuType = std::get<MainGpuType>(mainGpuValue);
    } else {
      // QVAC-23763: the two stable forms. Both resolve by scanning devices
      // rather than indexing, which is the whole point - an index is what
      // backend load order moves.
      //
      // Not found is a WARN and a fall-through to the full enumeration, exactly
      // as an out-of-range integer behaves: the device may simply be absent on
      // this machine, which is not a config error.
      const std::optional<size_t> resolved =
          ::resolveNamedMainGpu(bckI, mainGpuValue);
      if (resolved.has_value()) {
        ::tryEmplaceDevice(bckI, resolved.value(), std::nullopt, out);
        loopAllDevices = false;
      }
    }
  }
  for (size_t i = 0; loopAllDevices && i < bckI.ggml_backend_dev_count(); ++i) {
    ::tryEmplaceDevice(bckI, i, gpuType, out);
  }
  return out;
}

/// Mark the candidates this load cannot use. Never erases: the reason has to
/// survive for the trace, and marking rather than removing is what stops an
/// override resurrecting a device a guard just ruled out.
void applyExclusions(
    const BackendInterface& bckI, Enumeration& enumeration,
    const backend_selection::BackendRequest& req) {
  using backend_selection::ExclusionReason;

  auto excludeAll = [&](ExclusionReason reason) {
    for (Candidate& c : enumeration.candidates) {
      c.excluded = reason;
    }
  };
  auto excludeOpenClAdreno = [&](ExclusionReason reason) {
    for (Candidate& c : enumeration.candidates) {
      if (c.family == DeviceFamily::OpenClAdreno) {
        c.excluded = reason;
      }
    }
  };

  constexpr int kAdreno800Threshold = 800;
  const bool noMainGpuOverride = !req.mainGpu.has_value();
  const bool isAdreno = enumeration.maxAdrenoVersion.has_value();

  if (auto unsupported =
          backend_selection::getUnknownFinetuneArchitecture(req.metadata);
      req.isFinetuning && unsupported) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "Finetuning is not supported for architecture: " + unsupported.value());
  }

  const bool isBitnetOneBit =
      req.metadata != nullptr && req.metadata->hasOneBitQuantization() &&
      req.metadata->tryGetString("general.architecture") == "bitnet";

  if (noMainGpuOverride && isAdreno && req.isFinetuning) {
    if (enumeration.maxAdrenoVersion.value() >= kAdreno800Threshold) {
      bckI.llamaLogCallback(
          GGML_LOG_LEVEL_INFO,
          "Finetuning on Adreno 800+: preferring Vulkan",
          nullptr);
      excludeOpenClAdreno(ExclusionReason::FinetuneAdreno800Plus);
    } else {
      bckI.llamaLogCallback(
          GGML_LOG_LEVEL_INFO, "Finetuning on Adreno <800: CPU only", nullptr);
      excludeAll(ExclusionReason::FinetuneAdrenoBelow800);
    }
  } else if (noMainGpuOverride && isAdreno) {
    if (isBitnetOneBit &&
        enumeration.maxAdrenoVersion.value() < kAdreno800Threshold) {
      bckI.llamaLogCallback(
          GGML_LOG_LEVEL_INFO,
          "BitNet TQ on Adreno <800: only CPU supported",
          nullptr);
      excludeAll(ExclusionReason::BitnetAdrenoBelow800);
    } else if (
        isBitnetOneBit &&
        enumeration.maxAdrenoVersion.value() >= kAdreno800Threshold) {
      bckI.llamaLogCallback(
          GGML_LOG_LEVEL_INFO,
          "BitNet TQ on Adreno 800+: preferring Vulkan over OpenCL",
          nullptr);
      excludeOpenClAdreno(ExclusionReason::BitnetAdreno800Plus);
    }
  }

  // QVAC-23763: a device whose backend cannot run the requested KV-cache type
  // is passed over here, before the cascade picks, rather than the load being
  // refused after it. On a host with another GPU that can run it, that turns a
  // failed load into a working one on the next backend down.
  //
  // Runs after the guards above so a device already excluded keeps its original
  // reason, which is the more useful one to report.
  if (bckI.deviceSupportsKvCacheType == nullptr ||
      req.constraints.kvCacheTypes.empty()) {
    return;
  }
  for (Candidate& c : enumeration.candidates) {
    if (c.excluded != ExclusionReason::None) {
      continue;
    }
    for (const enum ggml_type kvType : req.constraints.kvCacheTypes) {
      if (!bckI.deviceSupportsKvCacheType(c.dev, kvType)) {
        std::string text = string_format(
            "%s cannot run KV-cache type %s; passing it over",
            c.name.c_str(),
            ggml_type_name(kvType));
        bckI.llamaLogCallback(GGML_LOG_LEVEL_INFO, text.c_str(), nullptr);
        c.excluded = ExclusionReason::KvCacheTypeUnsupported;
        break;
      }
    }
  }
}

// The default cascade. OpenClOther is deliberately absent: a non-Adreno OpenCL
// device is reachable only through an explicit override.
constexpr std::array<DeviceFamily, 4> K_CASCADE_ORDER = {
    DeviceFamily::OpenClAdreno,
    DeviceFamily::Cuda,
    DeviceFamily::Gpu,
    DeviceFamily::Igpu};

// The override's search order, which does include OpenClOther.
constexpr std::array<DeviceFamily, 5> K_OVERRIDE_ORDER = {
    DeviceFamily::OpenClAdreno,
    DeviceFamily::Cuda,
    DeviceFamily::Gpu,
    DeviceFamily::Igpu,
    DeviceFamily::OpenClOther};

/// Short stable token for a reason, for logs and error messages.
const char* exclusionReasonName(backend_selection::ExclusionReason reason) {
  using backend_selection::ExclusionReason;
  switch (reason) {
  case ExclusionReason::None:
    return "none";
  case ExclusionReason::FinetuneAdrenoBelow800:
    return "finetuning-on-adreno-below-800";
  case ExclusionReason::FinetuneAdreno800Plus:
    return "finetuning-on-adreno-800-plus";
  case ExclusionReason::BitnetAdrenoBelow800:
    return "bitnet-on-adreno-below-800";
  case ExclusionReason::BitnetAdreno800Plus:
    return "bitnet-on-adreno-800-plus";
  case ExclusionReason::KvCacheTypeUnsupported:
    return "kv-cache-type-unsupported";
  }
  return "unknown";
}

const char* selectionPathName(backend_selection::SelectionPath path) {
  using backend_selection::SelectionPath;
  switch (path) {
  case SelectionPath::Cascade:
    return "cascade";
  case SelectionPath::Override:
    return "override";
  case SelectionPath::Cpu:
    return "cpu";
  }
  return "unknown";
}

/// The one line that says what selection decided and why.
///
/// QVAC-23763: this replaces the four prose lines ("Chosen GPU CUDA", "Chosen
/// %s Backend (backend override)", …). Three integration suites matched that
/// prose, which coupled them to log wording and could only ever prove that an
/// override bound - not which backend actually won, nor why a higher-priority
/// one did not. Named fields make both assertable, and the addon exposes no API
/// that reports the selected backend, so the log is the only channel.
void emitSelectionLog(
    const BackendInterface& bckI, const backend_selection::SelectionTrace& t) {
  std::string text = string_format(
      "[backend-selection] selected=%s registry=%s path=%s",
      t.selectedName.empty() ? "none" : t.selectedName.c_str(),
      t.selectedRegistry.empty() ? "-" : t.selectedRegistry.c_str(),
      ::selectionPathName(t.path));
  if (t.skippedName.empty()) {
    text += " skipped=none";
  } else {
    text += string_format(
        " skipped=%s skipped_registry=%s skipped_reason=%s",
        t.skippedName.c_str(),
        t.skippedRegistry.empty() ? "-" : t.skippedRegistry.c_str(),
        ::exclusionReasonName(t.skippedReason));
  }
  bckI.llamaLogCallback(GGML_LOG_LEVEL_INFO, text.c_str(), nullptr);
}

/// Whether @p dev can run SET_ROWS writing @p kvType from F32, which is the op
/// llama_kv_cache builds for a quantized KV cache.
///
/// Mirrors qvac-fabric's own probe in llama-kv-cache.cpp. Only TBQ/PQ is asked
/// about: every other type is either universally supported or is refused for a
/// reason supports_op cannot see - OpenCL answers true for q8_0, whose real
/// failure is the shift/requantize path rather than the write path. So this is a
/// necessary capability test, not a sufficient one, and the hand-written OpenCL
/// rule in LoadFitNormalization stays.
bool productionSupportsKvCacheType(ggml_backend_dev_t dev, ggml_type kvType) {
  if (dev == nullptr || !ggml_is_tbq_or_pq(kvType)) {
    return true;
  }
  ggml_init_params probeParams = {
      /*mem_size=*/4096, /*mem_buffer=*/nullptr, /*no_alloc=*/true};
  ggml_context* probeCtx = ggml_init(probeParams);
  if (probeCtx == nullptr) {
    return true; // fail open
  }
  const int64_t blk = ggml_blck_size(kvType);
  ggml_tensor* dst = ggml_new_tensor_3d(probeCtx, kvType, blk, 1, 1);
  ggml_tensor* src = ggml_new_tensor_3d(probeCtx, GGML_TYPE_F32, blk, 1, 1);
  ggml_tensor* idx = ggml_new_tensor_2d(probeCtx, GGML_TYPE_I64, 1, 1);
  const bool ok =
      ggml_backend_dev_supports_op(dev, ggml_set_rows(probeCtx, dst, src, idx));
  ggml_free(probeCtx);
  return ok;
}

/// First surviving candidate of @p family. Callers iterate family-major and this
/// iterates enumeration-order-minor, which together preserve
/// first-registered-wins within a family.
const Candidate* firstUsable(const Enumeration& enumeration, DeviceFamily family) {
  for (const Candidate& c : enumeration.candidates) {
    if (c.family == family &&
        c.excluded == backend_selection::ExclusionReason::None) {
      return &c;
    }
  }
  return nullptr;
}
} // namespace

BackendType
backend_selection::preferredBackendTypeFromString(const std::string& device) {
  if (device == "gpu") {
    return BackendType::GPU;
  }
  if (device == "cpu") {
    return BackendType::CPU;
  }
  throw qvac_errors::StatusError(
      qvac_errors::general_error::InvalidArgument,
      "preferredDeviceFromString: wrong device specified, must be 'gpu' or "
      "'cpu'.\n");
}

namespace {

// Backend families qvac-fabric can register a GPU device for. Used to tell a
// mistyped `backend` value (hard error) apart from a correctly-spelled backend
// that simply has no device on this machine (falls through). Deliberately does
// NOT include "cpu": the CPU path is `device`, and accepting two spellings for
// it would make `device: 'gpu', backend: 'cpu'` ambiguous.
constexpr std::array<std::string_view, 7> KNOWN_GPU_BACKEND_FAMILIES = {
    "cuda", "vulkan", "metal", "opencl", "hip", "rocm", "sycl"};

// Trimmed from each family. \r matters: a value from a CRLF config file would
// otherwise throw "unknown backend 'cuda\r'", which renders identically to the
// accepted spelling.
constexpr std::string_view K_BACKEND_TRIM = " \t\r\n\v\f";

/// Whether a ggml device backend name belongs to the requested family.
/// Substring rather than equality because ggml suffixes the device index
/// ("CUDA0", "Vulkan1") and OpenCL reports as "GPUOpenCL". Metal is special:
/// some builds report "mtl..." instead of "Metal", which LoadFitNormalization
/// already special-cases the same way.
bool backendNameMatchesFamily(
    const std::string& lowercasedBackendName, std::string_view family) {
  if (lowercasedBackendName.find(family) != std::string::npos) {
    return true;
  }
  return family == "metal" && lowercasedBackendName.rfind("mtl", 0) == 0;
}

/// hip and rocm name the same family; ggml reports those devices as "ROCm%d".
std::string canonicaliseFamily(std::string family) {
  return family == "hip" ? "rocm" : family;
}

} // namespace

std::optional<MainGpu>
backend_selection::parseMainGpu(const std::string& mainGpuStr) {
  if (mainGpuStr.empty()) {
    return std::nullopt;
  }

  std::string lowerStr = mainGpuStr;
  std::ranges::transform(lowerStr, lowerStr.begin(), ::tolower);

  // QVAC-23763: the integer arm must consume the WHOLE value. It used to be
  // std::stoi, which parses a leading prefix and discards the rest, so a PCI bus
  // id like "0000:65:00.0" parsed silently as device 0. Requiring full
  // consumption is what makes the string forms below safe to add - and it is a
  // behaviour change in its own right: "1abc" no longer parses as 1.
  int deviceIndex = 0;
  const char* first = lowerStr.data();
  const char* last = first + lowerStr.size();
  if (auto [ptr, ec] = std::from_chars(first, last, deviceIndex);
      ec == std::errc() && ptr == last) {
    return MainGpu(deviceIndex);
  }

  if (lowerStr == "integrated") {
    return MainGpu(MainGpuType::Integrated);
  }
  if (lowerStr == "dedicated") {
    return MainGpu(MainGpuType::Dedicated);
  }

  // "<family>:<index>", e.g. "cuda:0". Checked before the bus id: neither shape
  // can match the other, since a family is alphabetic and a bus id is not.
  static const std::regex qualifiedRe(R"(^([a-z]+):([0-9]+)$)");
  if (std::smatch m; std::regex_match(lowerStr, m, qualifiedRe)) {
    const std::string family = ::canonicaliseFamily(m[1].str());
    if (std::ranges::find(KNOWN_GPU_BACKEND_FAMILIES, family) ==
        KNOWN_GPU_BACKEND_FAMILIES.end()) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          string_format(
              "main-gpu names an unknown backend family '%s'. Known families: "
              "cuda, vulkan, metal, opencl, hip, rocm, sycl.",
              m[1].str().c_str()));
    }
    int index = 0;
    const std::string digits = m[2].str();
    std::from_chars(digits.data(), digits.data() + digits.size(), index);
    return MainGpu(MainGpuQualified{family, index});
  }

  // A PCI bus id as ggml publishes it in props.device_id, with the domain
  // optional: "0000:65:00.0" or "65:00.0".
  static const std::regex busIdRe(
      R"(^([0-9a-f]{4}:)?[0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f]$)");
  if (std::regex_match(lowerStr, busIdRe)) {
    return MainGpu(MainGpuBusId{lowerStr});
  }

  throw qvac_errors::StatusError(
      qvac_errors::general_error::InvalidArgument,
      "main-gpu must be a device index (e.g. '0'), 'integrated', 'dedicated', "
      "a backend-qualified index (e.g. 'cuda:0'), or a PCI bus id (e.g. "
      "'0000:65:00.0'). A bare index depends on backend load order; prefer one "
      "of the latter two.");
}

std::vector<std::string>
backend_selection::parseBackendOverride(const std::string& backendStr) {
  std::vector<std::string> families;
  std::string current;
  // Set for any non-blank token, 'auto' included, so 'auto' on its own is not
  // then rejected by the names-no-backend check below.
  bool namedAnyBackend = false;
  auto flush = [&]() {
    const auto begin = current.find_first_not_of(K_BACKEND_TRIM);
    if (begin == std::string::npos) {
      return;
    }
    const auto end = current.find_last_not_of(K_BACKEND_TRIM);
    std::string family = current.substr(begin, end - begin + 1);
    // Cast to unsigned char: std::tolower takes an int and is undefined for a
    // negative value, which a signed char is for any byte >= 0x80. `backend`
    // is caller-supplied, so it can carry non-ASCII.
    std::ranges::transform(family, family.begin(), [](unsigned char c) {
      return static_cast<char>(std::tolower(c));
    });
    namedAnyBackend = true;
    // 'auto' is vla-ggml's documented default for this same key, so accept and
    // drop it here rather than rejecting a selector that works on that addon.
    // 'auto' alone yields no families, which callers already read as no
    // override.
    if (family == "auto") {
      return;
    }
    if (std::ranges::find(KNOWN_GPU_BACKEND_FAMILIES, family) ==
        KNOWN_GPU_BACKEND_FAMILIES.end()) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          string_format(
              "backend: unknown backend '%s'. Expected a comma-separated list "
              "of cuda/vulkan/metal/opencl/hip/rocm/sycl or 'auto', for "
              "example "
              "'cuda,vulkan'. To run on CPU use device 'cpu' instead.\n",
              family.c_str()));
    }
    // ggml's HIP build names its devices "ROCm%d" (GGML_CUDA_NAME in
    // ggml-cuda.h), so a family kept as "hip" matches no device name at all.
    // Canonicalise to the spelling ggml actually reports; both spellings stay
    // accepted on the way in, and the dedup below then merges "hip,rocm".
    if (family == "hip") {
      family = "rocm";
    }
    if (std::ranges::find(families, family) == families.end()) {
      families.emplace_back(std::move(family));
    }
  };
  for (const char c : backendStr) {
    if (c == ',') {
      flush();
      current.clear();
    } else {
      current.push_back(c);
    }
  }
  flush();
  // An absent or blank value means the key was not configured. Anything else
  // that parses to zero families, "," or ",,", is a config mistake and gets the
  // same hard error as a misspelled name.
  if (families.empty() && !namedAnyBackend &&
      backendStr.find_first_not_of(K_BACKEND_TRIM) != std::string::npos) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        string_format(
            "backend: '%s' names no backend. Expected a comma-separated list "
            "of cuda/vulkan/metal/opencl/hip/rocm/sycl or 'auto', for example "
            "'cuda,vulkan'. To run on CPU use device 'cpu' instead.\n",
            backendStr.c_str()));
  }
  return families;
}

std::vector<std::string> backend_selection::tryBackendOverrideFromMap(
    std::unordered_map<std::string, std::string>& configFilemap) {
  auto it = configFilemap.find("backend");
  if (it == configFilemap.end()) {
    return {};
  }
  std::vector<std::string> families = parseBackendOverride(it->second);
  configFilemap.erase(it);
  return families;
}

bool backend_selection::tryBackendRequiredFromMap(
    std::unordered_map<std::string, std::string>& configFilemap,
    const bool backendOverridePresent) {
  auto hIt = configFilemap.find("backend-required");
  auto uIt = configFilemap.find("backend_required");
  if (hIt != configFilemap.end() && uIt != configFilemap.end()) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "both 'backend-required' and 'backend_required' are present; use one "
        "or the other.");
  }
  auto it = hIt != configFilemap.end() ? hIt : uIt;
  if (it == configFilemap.end()) {
    return false;
  }

  std::string value = it->second;
  std::ranges::transform(value, value.begin(), ::tolower);
  value.erase(0, value.find_first_not_of(K_BACKEND_TRIM));
  const size_t end = value.find_last_not_of(K_BACKEND_TRIM);
  if (end != std::string::npos) {
    value.erase(end + 1);
  }

  bool required = false;
  if (value == "true" || value == "on" || value == "1") {
    required = true;
  } else if (value == "false" || value == "off" || value == "0") {
    required = false;
  } else {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        string_format(
            "backend-required must be true/on/1 or false/off/0, got '%s'.",
            it->second.c_str()));
  }
  configFilemap.erase(it);

  // Only meaningful alongside `backend`. On its own it reads as "require the
  // default cascade", which is not a thing, so it is far more likely to be a
  // mistake than an intent.
  if (required && !backendOverridePresent) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "backend-required is set but no 'backend' was given; it makes a "
        "backend priority list binding and has no meaning without one.");
  }
  return required;
}

std::optional<MainGpu> backend_selection::tryMainGpuFromMap(
    std::unordered_map<std::string, std::string>& configFilemap) {
  auto hIt = configFilemap.find("main-gpu");
  auto uIt = configFilemap.find("main_gpu");
  if (hIt != configFilemap.end() && uIt != configFilemap.end()) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "both 'main-gpu' and 'main_gpu' are present; use one or the other.");
  }
  auto it = (hIt != configFilemap.end()) ? hIt : uIt;
  if (it == configFilemap.end()) {
    return std::nullopt;
  }
  std::optional<MainGpu> mainGpu = parseMainGpu(it->second);
  configFilemap.erase(it);
  return mainGpu;
}

enum ggml_type backend_selection::kvCacheTypeFromString(const std::string& name) {
  // qvac-fabric's own kv_cache_type_from_str is static in common/arg.cpp and
  // cannot be linked, so scan ggml's names instead. Both sides are lowercase.
  std::string lowered = name;
  std::transform(lowered.begin(), lowered.end(), lowered.begin(), ::tolower);
  for (int t = 0; t < GGML_TYPE_COUNT; ++t) {
    const enum ggml_type type = static_cast<enum ggml_type>(t);
    const char* typeName = ggml_type_name(type);
    if (typeName != nullptr && lowered == typeName) {
      return type;
    }
  }
  return GGML_TYPE_COUNT;
}

backend_selection::BackendFamilyCode backend_selection::backendFamilyCodeOf(
    const BackendType type, const std::string& deviceName) {
  if (type == BackendType::CPU) {
    return BackendFamilyCode::Cpu;
  }
  if (deviceName.empty() || deviceName == "none") {
    return BackendFamilyCode::None;
  }
  // Same substring matching the `backend` override uses, so a device that an
  // override can name is reported under the family that named it. Order
  // matters only for rocm/hip, which are the same family under two spellings.
  if (::backendNameMatchesFamily(deviceName, "cuda")) {
    return BackendFamilyCode::Cuda;
  }
  if (::backendNameMatchesFamily(deviceName, "rocm") ||
      ::backendNameMatchesFamily(deviceName, "hip")) {
    return BackendFamilyCode::Rocm;
  }
  if (::backendNameMatchesFamily(deviceName, "vulkan")) {
    return BackendFamilyCode::Vulkan;
  }
  if (::backendNameMatchesFamily(deviceName, "opencl")) {
    return BackendFamilyCode::OpenCl;
  }
  if (::backendNameMatchesFamily(deviceName, "metal")) {
    return BackendFamilyCode::Metal;
  }
  if (::backendNameMatchesFamily(deviceName, "sycl")) {
    return BackendFamilyCode::Sycl;
  }
  // A GPU from a backend this build does not know by name. Reported rather
  // than folded into None, so "ran on something unrecognised" stays
  // distinguishable from "ran on nothing".
  return BackendFamilyCode::Other;
}

backend_selection::ExclusionKind
backend_selection::kindOf(const ExclusionReason reason) {
  // No default: a new reason must be classified here before this compiles.
  switch (reason) {
  case ExclusionReason::None:
  case ExclusionReason::FinetuneAdrenoBelow800:
  case ExclusionReason::FinetuneAdreno800Plus:
  case ExclusionReason::BitnetAdrenoBelow800:
  case ExclusionReason::BitnetAdreno800Plus:
    // These guards actively want another backend, and CPU is a legitimate
    // destination for all of them - it is where they already land today.
    return ExclusionKind::PreferOther;
  case ExclusionReason::KvCacheTypeUnsupported:
    // Not a preference: the device genuinely cannot run this load. If nothing
    // else can either, that is worth failing rather than silently running an
    // order of magnitude slower than the caller asked for.
    return ExclusionKind::Incapable;
  }
  return ExclusionKind::PreferOther;
}

backend_selection::BackendChoice backend_selection::chooseBackend(
    const BackendRequest& request, const BackendInterface& bckI) {
  Enumeration enumeration = ::enumerateCandidates(bckI, request);
  ::applyExclusions(bckI, enumeration, request);

  BackendChoice choice;
  choice.adrenoVersion = enumeration.maxAdrenoVersion;
  choice.isMaliGpu = enumeration.sawMaliGpu;

  // The highest-priority candidate that was passed over, for the trace. Recorded
  // before a winner is picked so it survives whichever path wins.
  const Candidate* skipped = nullptr;
  for (const DeviceFamily family : ::K_CASCADE_ORDER) {
    for (const Candidate& c : enumeration.candidates) {
      if (c.family == family && c.excluded != ExclusionReason::None) {
        skipped = &c;
        break;
      }
    }
    if (skipped != nullptr) {
      break;
    }
  }
  if (skipped != nullptr) {
    choice.trace.skippedName = skipped->name;
    choice.trace.skippedRegistry = skipped->registry;
    choice.trace.skippedReason = skipped->excluded;
  }

  auto settle = [&](const Candidate& c, SelectionPath path) {
    choice.type = BackendType::GPU;
    choice.name = c.name;
    choice.trace.selectedName = c.name;
    choice.trace.selectedRegistry = c.registry;
    choice.trace.path = path;
    ::emitSelectionLog(bckI, choice.trace);
    return choice;
  };

  // QVAC-23763: an explicit `backend` override wins over the cascade below, but
  // only over candidates that survived the guards: firstUsable() skips excluded
  // ones, so a request for a backend a guard just ruled out cannot resurrect it.
  //
  // Skipped entirely for a CPU load. No devices are enumerated in that case, so
  // the block could only ever reach its "matched no available device" warning,
  // which would be noise on a deliberate device:'cpu' request.
  if (!request.backendOverride.empty() &&
      request.preferred == BackendType::GPU) {
    for (const std::string& family : request.backendOverride) {
      for (const DeviceFamily deviceFamily : ::K_OVERRIDE_ORDER) {
        for (const Candidate& c : enumeration.candidates) {
          if (c.family != deviceFamily ||
              c.excluded != ExclusionReason::None) {
            continue;
          }
          if (::backendNameMatchesFamily(c.name, family)) {
            return settle(c, SelectionPath::Override);
          }
        }
      }
    }
    // QVAC-23763: name what WAS enumerated. Without it, diagnosing a pin that
    // missed takes a second run with verbose logging - and the reason a
    // candidate was passed over is exactly what the caller needs to see.
    std::string enumerated;
    for (const Candidate& c : enumeration.candidates) {
      if (!enumerated.empty()) {
        enumerated += ", ";
      }
      enumerated += c.name + " (" + c.registry + ")";
      if (c.excluded != ExclusionReason::None) {
        enumerated += " [passed over: ";
        enumerated += ::exclusionReasonName(c.excluded);
        enumerated += "]";
      }
    }
    if (enumerated.empty()) {
      enumerated = "none";
    }

    std::string requested;
    for (const std::string& family : request.backendOverride) {
      if (!requested.empty()) {
        requested += ",";
      }
      requested += family;
    }

    if (request.backendRequired) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          string_format(
              "backend '%s' is required but matched no available device. "
              "Enumerated: %s.\n",
              requested.c_str(),
              enumerated.c_str()));
    }
    std::string warning = string_format(
        "backend override '%s' matched no available device; falling back to "
        "the default backend order. Enumerated: %s",
        requested.c_str(),
        enumerated.c_str());
    bckI.llamaLogCallback(GGML_LOG_LEVEL_WARN, warning.c_str(), nullptr);
  }

  for (const DeviceFamily family : ::K_CASCADE_ORDER) {
    if (const Candidate* c = ::firstUsable(enumeration, family); c != nullptr) {
      return settle(*c, SelectionPath::Cascade);
    }
  }

  // QVAC-23763: nothing survived. If any candidate was ruled Incapable rather
  // than merely deprioritised, the caller asked for a GPU load this host cannot
  // run, and quietly dropping to CPU would be an order of magnitude slower than
  // what they asked for. Say what was filtered and why.
  //
  // The PreferOther guards deliberately do not reach here as an error: landing
  // on CPU is what BitNet-on-Adreno<800 and finetuning-on-Adreno<800 are for.
  if (request.preferred == BackendType::GPU) {
    std::string incapable;
    for (const Candidate& c : enumeration.candidates) {
      if (c.excluded == ExclusionReason::None ||
          kindOf(c.excluded) != ExclusionKind::Incapable) {
        continue;
      }
      if (!incapable.empty()) {
        incapable += ", ";
      }
      incapable += c.name + " (" + c.registry + ")";
    }
    if (!incapable.empty()) {
      std::string kvTypes;
      for (const enum ggml_type kvType : request.constraints.kvCacheTypes) {
        if (!kvTypes.empty()) {
          kvTypes += "/";
        }
        kvTypes += ggml_type_name(kvType);
      }
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          string_format(
              "No available GPU can run KV-cache type %s. Passed over: %s. "
              "Either pick a different cache type "
              "(f32/f16/bf16/q4_0/q4_1/q5_0/q5_1/q8_0/iq4_nl) or set "
              "device to cpu.\n",
              kvTypes.c_str(),
              incapable.c_str()));
    }
  }

  choice.trace.path = SelectionPath::Cpu;
  ::emitSelectionLog(bckI, choice.trace);
  return choice;
}

backend_selection::BackendChoice backend_selection::chooseBackend(
    const BackendRequest& request, llamaLogCallbackF llamaLogcallback) {
  BackendInterface bckI{
      ggml_backend_dev_count,
      ggml_backend_dev_backend_reg,
      ggml_backend_dev_get,
      ggml_backend_reg_name,
      ggml_backend_dev_description,
      ggml_backend_dev_name,
      ggml_backend_dev_type,
      ggml_backend_reg_get_proc_address,
      ggml_backend_dev_get_props,
      llamaLogcallback,
      ::productionSupportsKvCacheType};
  return chooseBackend(request, bckI);
}

std::pair<BackendType, std::string> backend_selection::chooseBackend(
    const BackendType preferredBackendType, const BackendInterface& bckI,
    const ModelMetaData* metadata, const std::optional<MainGpu>& mainGpu,
    std::optional<int>* outAdrenoVersion, const bool isFinetuning,
    bool* outIsMaliGpu, const std::vector<std::string>& backendOverride) {
  BackendRequest request;
  request.preferred = preferredBackendType;
  request.metadata = metadata;
  request.mainGpu = mainGpu;
  request.isFinetuning = isFinetuning;
  request.backendOverride = backendOverride;

  const BackendChoice choice = chooseBackend(request, bckI);

  if (outAdrenoVersion != nullptr) {
    *outAdrenoVersion = choice.adrenoVersion;
  }
  if (outIsMaliGpu != nullptr) {
    *outIsMaliGpu = choice.isMaliGpu;
  }
  return {choice.type, choice.name};
};

std::pair<BackendType, std::string> backend_selection::chooseBackend(
    const BackendType preferredBackendType, llamaLogCallbackF llamaLogcallback,
    const std::optional<MainGpu>& mainGpu, const ModelMetaData* metadata,
    std::optional<int>* outAdrenoVersion, const bool isFinetuning,
    bool* outIsMaliGpu, const std::vector<std::string>& backendOverride) {
  BackendInterface bckI{
      ggml_backend_dev_count,
      ggml_backend_dev_backend_reg,
      ggml_backend_dev_get,
      ggml_backend_reg_name,
      ggml_backend_dev_description,
      ggml_backend_dev_name,
      ggml_backend_dev_type,
      ggml_backend_reg_get_proc_address,
      ggml_backend_dev_get_props,
      llamaLogcallback,
      ::productionSupportsKvCacheType};
  return backend_selection::chooseBackend(
      preferredBackendType,
      bckI,
      metadata,
      mainGpu,
      outAdrenoVersion,
      isFinetuning,
      outIsMaliGpu,
      backendOverride);
}

size_t
backend_selection::getEffectiveGpuDeviceCount(const BackendInterface& bckI) {
  size_t gpuCount = 0;
  size_t igpuCount = 0;
  const size_t totalDevices = bckI.ggml_backend_dev_count();
  for (size_t i = 0; i < totalDevices; ++i) {
    ggml_backend_dev_t dev = bckI.ggml_backend_dev_get(i);
    enum ggml_backend_dev_type devType = bckI.ggml_backend_dev_type(dev);
    if (devType == GGML_BACKEND_DEVICE_TYPE_GPU) {
      ++gpuCount;
    } else if (devType == GGML_BACKEND_DEVICE_TYPE_IGPU) {
      ++igpuCount;
    }
  }
  return gpuCount > 0 ? gpuCount : igpuCount;
}

std::vector<std::string>
backend_selection::getTensorSplitDeviceNames(const BackendInterface& bckI) {
  std::vector<std::string> discrete;
  std::vector<std::string> integrated;
  std::unordered_set<std::string> seenDiscrete;
  std::unordered_set<std::string> seenIntegrated;

  const size_t totalDevices = bckI.ggml_backend_dev_count();
  for (size_t i = 0; i < totalDevices; ++i) {
    ggml_backend_dev_t dev = bckI.ggml_backend_dev_get(i);
    const enum ggml_backend_dev_type devType = bckI.ggml_backend_dev_type(dev);
    const bool isDiscrete = devType == GGML_BACKEND_DEVICE_TYPE_GPU;
    if (!isDiscrete && devType != GGML_BACKEND_DEVICE_TYPE_IGPU) {
      continue;
    }
    // Skip RPC devices, matching both qvac-fabric's filtered branch and
    // emplaceIfValidDevice above. ggml types them as GPU, so without this an
    // iGPU + RPC host would see a non-empty `discrete` bucket and drop its own
    // integrated GPU from the list.
    const ggml_backend_reg_t reg = bckI.ggml_backend_dev_backend_reg(dev);
    if (reg != nullptr &&
        bckI.ggml_backend_reg_name(reg) == std::string("RPC")) {
      continue;
    }
    // Materialise each string before the next interface call. The returned
    // pointers are not guaranteed to outlive a subsequent call on the same
    // interface, and holding one across another call is a use-after-free
    // against any implementation that stores results in a reallocating
    // container. DeviceDescription above is safe for the same reason: its
    // std::string members copy in declaration order.
    ggml_backend_dev_props props{};
    bckI.ggml_backend_dev_get_props(dev, &props);
    const std::string deviceId = props.device_id != nullptr
                                     ? std::string(props.device_id)
                                     : std::string();
    const char* namePtr = bckI.ggml_backend_dev_name(dev);
    // An empty name would join into a leading or trailing comma and make the
    // whole --device list unparseable, so it is skipped like a null one.
    if (namePtr == nullptr || *namePtr == '\0') {
      continue;
    }
    auto& bucket = isDiscrete ? discrete : integrated;
    auto& seen = isDiscrete ? seenDiscrete : seenIntegrated;
    // A null device_id cannot be deduped against; keep the device rather than
    // dropping it, since omitting a real GPU is worse than a duplicate. This
    // mirrors fabric, whose find_if only matches when both ids are non-null.
    if (deviceId.empty() || seen.insert(deviceId).second) {
      bucket.emplace_back(namePtr);
    }
  }
  return !discrete.empty() ? discrete : integrated;
}

std::vector<std::string> backend_selection::getTensorSplitDeviceNames() {
  BackendInterface bckI{
      ggml_backend_dev_count,
      ggml_backend_dev_backend_reg,
      ggml_backend_dev_get,
      ggml_backend_reg_name,
      ggml_backend_dev_description,
      ggml_backend_dev_name,
      ggml_backend_dev_type,
      ggml_backend_reg_get_proc_address,
      ggml_backend_dev_get_props,
      nullptr};
  return getTensorSplitDeviceNames(bckI);
}

bool backend_selection::gpuBackendSupportsRowSplit(
    const BackendInterface& bckI) {
  // Mirror what qvac-fabric actually checks: llama_model::load_tensors() calls
  // make_gpu_buft_list() for EVERY device it was given and throws "device %s
  // does not support split buffers" on the first one whose backend registry
  // lacks `ggml_backend_split_buffer_type`. So require all of them, not any
  // one, and treat "no GPU devices at all" as unsupported.
  //
  // QVAC-23763: split mode now scopes `--device` to one registry (see
  // splitModeDeviceNames), so qvac-fabric sees a narrower set than is checked
  // here. Left registry-wide on purpose: that only degrades row to layer sooner
  // than needed, never the other way, and no shipped backend has split buffers.
  size_t gpuDevices = 0;
  const size_t totalDevices = bckI.ggml_backend_dev_count();
  for (size_t i = 0; i < totalDevices; ++i) {
    ggml_backend_dev_t dev = bckI.ggml_backend_dev_get(i);
    const enum ggml_backend_dev_type devType = bckI.ggml_backend_dev_type(dev);
    if (devType != GGML_BACKEND_DEVICE_TYPE_GPU &&
        devType != GGML_BACKEND_DEVICE_TYPE_IGPU) {
      continue;
    }
    ++gpuDevices;
    ggml_backend_reg_t reg = bckI.ggml_backend_dev_backend_reg(dev);
    if (reg == nullptr ||
        bckI.ggml_backend_reg_get_proc_address(
            reg, "ggml_backend_split_buffer_type") == nullptr) {
      return false;
    }
  }
  return gpuDevices > 0;
}

bool backend_selection::gpuBackendSupportsRowSplit() {
  BackendInterface bckI{
      ggml_backend_dev_count,
      ggml_backend_dev_backend_reg,
      ggml_backend_dev_get,
      ggml_backend_reg_name,
      ggml_backend_dev_description,
      ggml_backend_dev_name,
      ggml_backend_dev_type,
      ggml_backend_reg_get_proc_address,
      ggml_backend_dev_get_props,
      nullptr,
      ::productionSupportsKvCacheType};
  return backend_selection::gpuBackendSupportsRowSplit(bckI);
}

backend_selection::SplitDeviceList backend_selection::splitModeDeviceNamesDetailed(
    const BackendInterface& bckI, const std::string& selectedDeviceName) {
  // Kept in ggml's enumeration order, so the list matches what qvac-fabric
  // would have discovered on its own.
  struct SplitCandidate {
    std::string registry;
    std::string name;
    std::string deviceId;
    bool isIgpu;
  };
  std::vector<SplitCandidate> devices;
  std::vector<std::string> registries;
  std::string selectedRegistry;
  bool selectedIsIgpu = false;

  const size_t totalDevices = bckI.ggml_backend_dev_count();
  for (size_t i = 0; i < totalDevices; ++i) {
    ggml_backend_dev_t dev = bckI.ggml_backend_dev_get(i);
    const enum ggml_backend_dev_type devType = bckI.ggml_backend_dev_type(dev);
    if (devType != GGML_BACKEND_DEVICE_TYPE_GPU &&
        devType != GGML_BACKEND_DEVICE_TYPE_IGPU) {
      continue;
    }
    ggml_backend_reg_t reg = bckI.ggml_backend_dev_backend_reg(dev);
    if (reg == nullptr) {
      continue;
    }
    std::string registry = bckI.ggml_backend_reg_name(reg);
    // RPC is skipped for the same reason emplaceIfValidDevice skips it: those
    // devices are never candidates for selection in the first place.
    if (registry == "RPC") {
      continue;
    }
    std::string deviceName = bckI.ggml_backend_dev_name(dev);
    std::ranges::transform(deviceName, deviceName.begin(), [](unsigned char c) {
      return static_cast<char>(std::tolower(c));
    });
    const bool isIgpu = devType == GGML_BACKEND_DEVICE_TYPE_IGPU;
    if (deviceName == selectedDeviceName) {
      selectedRegistry = registry;
      selectedIsIgpu = isIgpu;
    }
    if (std::ranges::find(registries, registry) == registries.end()) {
      registries.push_back(registry);
    }
    // Both CUDA and Vulkan publish the PCI bus id here, lowercased and in the
    // same "domain:bus:device.function" form, which is what makes them
    // comparable across registries. An absent id is left empty; see below.
    std::string deviceId;
    if (bckI.ggml_backend_dev_get_props != nullptr) {
      ggml_backend_dev_props props{};
      bckI.ggml_backend_dev_get_props(dev, &props);
      if (props.device_id != nullptr) {
        deviceId = props.device_id;
      }
    }
    devices.push_back(
        {std::move(registry),
         std::move(deviceName),
         std::move(deviceId),
         isIgpu});
  }

  if (registries.size() < 2 || selectedRegistry.empty()) {
    return {};
  }

  // QVAC-23763: mirror qvac-fabric's own iGPU rules, because they only apply on
  // the path this list bypasses. llama_prepare_model_devices() drops iGPUs once
  // any discrete GPU was found and keeps at most one otherwise, but with
  // `--device` set it takes every named device verbatim, so emitting an iGPU
  // beside a discrete card would put layers on hardware it would never have
  // used. A deliberately selected iGPU, `main-gpu: 'integrated'`, is the
  // exception: scope to that one device.
  if (selectedIsIgpu) {
    SplitDeviceList single;
    single.names.push_back(selectedDeviceName);
    single.registries.push_back(selectedRegistry);
    return single;
  }

  // Dedupe by device_id rather than scoping to the selected registry. The
  // hazard this list exists for is one physical card registering under two
  // backends; scoping by registry also dropped a *second* physical card on a
  // mixed-vendor host, an NVIDIA plus a discrete AMD say, which is the very
  // population split mode is for. Preferring the selected registry on a tie
  // keeps an explicit `backend` override binding, which omitting `--device`
  // would not: qvac-fabric's own dedupe keeps whichever backend registered
  // first, and CUDA loads before Vulkan.
  // Deduping needs EVERY selected-registry device to publish a bus id. One that
  // does not leaves no key to match its twin in another registry by, and a
  // partial key list is worse than none: the cross-registry skip below would
  // not fire, so the id-less device and its id-bearing twin would both be
  // emitted, naming one physical card twice. Fall back to registry scoping for
  // the whole list in that case.
  bool selectedRegistryHasAllIds = true;
  std::vector<std::string> selectedIds;
  for (const auto& candidate : devices) {
    if (candidate.isIgpu || candidate.registry != selectedRegistry) {
      continue;
    }
    if (candidate.deviceId.empty()) {
      selectedRegistryHasAllIds = false;
    } else {
      selectedIds.push_back(candidate.deviceId);
    }
  }

  SplitDeviceList out;
  std::vector<std::string> seenIds;
  for (const auto& candidate : devices) {
    if (candidate.isIgpu) {
      continue;
    }
    // Either there is no usable key set at all, or this particular device has
    // no id to match on. Both reduce to registry scoping, which can never name
    // one card twice.
    if (!selectedRegistryHasAllIds || candidate.deviceId.empty()) {
      if (candidate.registry == selectedRegistry) {
        out.names.push_back(candidate.name);
        out.registries.push_back(candidate.registry);
      }
      continue;
    }
    if (std::ranges::find(seenIds, candidate.deviceId) != seenIds.end()) {
      continue;
    }
    if (candidate.registry != selectedRegistry &&
        std::ranges::find(selectedIds, candidate.deviceId) !=
            selectedIds.end()) {
      continue;
    }
    seenIds.push_back(candidate.deviceId);
    out.names.push_back(candidate.name);
    out.registries.push_back(candidate.registry);
  }

  // QVAC-23763: a split whose devices span more than one registry. Once an
  // uncovered NVIDIA card is refused by CUDA but still registered by Vulkan,
  // this stops being a mixed-vendor curiosity and becomes any single-vendor box
  // with mixed generations - a 5090 with an older card still in a slot, say.
  //
  // Membership is deliberately unchanged: dropping the foreign-registry card
  // was considered and rejected, because #4126 chose to keep a second physical
  // card that only another backend registers. This only makes the situation
  // visible, since an even tensor-split will pace the model to the slower card
  // and nothing else says so.
  for (const std::string& registry : out.registries) {
    if (registry != out.registries.front()) {
      out.heterogeneous = true;
      break;
    }
  }
  return out;
}

std::vector<std::string> backend_selection::splitModeDeviceNames(
    const BackendInterface& bckI, const std::string& selectedDeviceName) {
  return splitModeDeviceNamesDetailed(bckI, selectedDeviceName).names;
}

std::vector<std::string>
backend_selection::splitModeDeviceNames(const std::string& selectedDeviceName) {
  BackendInterface bckI{
      ggml_backend_dev_count,
      ggml_backend_dev_backend_reg,
      ggml_backend_dev_get,
      ggml_backend_reg_name,
      ggml_backend_dev_description,
      ggml_backend_dev_name,
      ggml_backend_dev_type,
      ggml_backend_reg_get_proc_address,
      ggml_backend_dev_get_props,
      nullptr,
      ::productionSupportsKvCacheType};
  return backend_selection::splitModeDeviceNames(bckI, selectedDeviceName);
}

backend_selection::SplitDeviceList
backend_selection::splitModeDeviceNamesDetailed(
    const std::string& selectedDeviceName) {
  BackendInterface bckI{
      ggml_backend_dev_count,
      ggml_backend_dev_backend_reg,
      ggml_backend_dev_get,
      ggml_backend_reg_name,
      ggml_backend_dev_description,
      ggml_backend_dev_name,
      ggml_backend_dev_type,
      ggml_backend_reg_get_proc_address,
      ggml_backend_dev_get_props,
      nullptr,
      ::productionSupportsKvCacheType};
  return backend_selection::splitModeDeviceNamesDetailed(
      bckI, selectedDeviceName);
}
