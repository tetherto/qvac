#include "model-interface/LoadFitNormalization.hpp"

#include <algorithm>
#include <cctype>
#include <cinttypes>
#include <initializer_list>
#include <iterator>
#include <sstream>
#include <stdexcept>
#include <string_view>
#include <thread>
#include <unordered_set>
#include <utility>

#include <common/arg.h>
#include <common/chat.h>
#include <common/log.h>
#include <ggml-backend.h>
#include <inference-addon-cpp/Errors.hpp>
#ifdef __APPLE__
#include <TargetConditionals.h>
#endif

#include "addon/LlmErrors.hpp"
#include "handlers/LoadConfigHandlers.hpp"
#include "utils/ChatTemplateUtils.hpp"
#include "utils/LoggingMacros.hpp"

using namespace qvac_lib_inference_addon_llama::errors;
using namespace qvac_lib_inference_addon_cpp::logger;
using namespace qvac_lib_inference_addon_llama::logging;

namespace {

constexpr std::string_view K_LEGACY_PARSER_NAME = "commonParamsParse";

std::vector<std::string> split(const std::string& str, char delimiter) {
  auto trim = [](const std::string& value) -> std::string {
    auto start =
        std::find_if(value.begin(), value.end(), [](unsigned char character) {
          return std::isspace(character) == 0;
        });

    if (start == value.end()) {
      return "";
    }

    auto end =
        std::find_if(value.rbegin(), value.rend(), [](unsigned char character) {
          return std::isspace(character) == 0;
        }).base();

    return {start, end};
  };

  std::vector<std::string> tokens;
  std::istringstream stream(str);
  std::string token;

  while (std::getline(stream, token, delimiter)) {
    auto trimmed = trim(token);
    if (!trimmed.empty()) {
      tokens.push_back(std::move(trimmed));
    }
  }
  return tokens;
}

// Finds exactly one of `keys` present in `configFilemap`. Throws
// InvalidArgument, naming every key in `keys`, if more than one is present —
// the shared shape behind every "accept 'foo' or 'foo_bar', not both" config
// key in this file (split-mode, rpc-servers/rpc_servers/rpc, devices/
// device-list, mmproj-use-gpu). Returns configFilemap.end() if none are
// present; callers still do their own value parsing and erase() on use.
load_fit_normalization::ConfigMap::iterator findOneOfAliasedKeys(
    load_fit_normalization::ConfigMap& configFilemap,
    std::initializer_list<std::string_view> keys) {
  std::vector<load_fit_normalization::ConfigMap::iterator> found;
  for (const std::string_view key : keys) {
    if (auto it = configFilemap.find(std::string(key));
        it != configFilemap.end()) {
      found.push_back(it);
    }
  }
  if (found.size() > 1) {
    std::string joined;
    for (const std::string_view key : keys) {
      if (!joined.empty()) {
        joined += ", ";
      }
      joined += "'";
      joined += key;
      joined += "'";
    }
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        string_format(
            "%s: more than one of %s is present; use exactly one.\n",
            K_LEGACY_PARSER_NAME.data(),
            joined.c_str()));
  }
  return found.empty() ? configFilemap.end() : found.front();
}

// QVAC-24112: register remote RPC devices before backend selection runs.
//
// llama.cpp registers RPC endpoints from its own `--rpc` handler, which the
// passthrough loop below does not reach until long after chooseBackend() has
// already picked a device. Registering here makes the remote devices visible
// to the selection pass; see the call site for the ordering contract.
//
// Mirrors add_rpc_devices() in common/arg.cpp, which is static and so cannot be
// linked against. Two deliberate differences:
//
//  - Upstream calls ggml_backend_load_all() first. We must not: the caller has
//    already loaded backends through LlamaBackendsHandle (LlamaModel.cpp:193),
//    which honours the configured backends directory. Loading again here would
//    pull from the default search path as well, registering duplicate or
//    unintended backends wherever they ship as separate shared objects.
//
//  - ggml_backend_rpc_add_server() returns nullptr for an endpoint it cannot
//    reach, and upstream passes that straight to ggml_backend_register().
//    That is not a crash (register_backend early-returns on null), which is
//    the problem: the endpoint is dropped silently and the load continues on
//    whatever devices remain. We reject it naming the endpoint instead.
std::vector<std::string> registerRpcDevices(const std::string& servers) {
  const std::vector<std::string> endpoints = split(servers, ',');
  if (endpoints.empty()) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        string_format(
            "%s: 'rpc-servers' is empty; expected a comma-separated list of "
            "host:port endpoints.\n",
            K_LEGACY_PARSER_NAME.data()));
  }

  ggml_backend_reg_t rpcReg = ggml_backend_reg_by_name("RPC");
  if (rpcReg == nullptr) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        string_format(
            "%s: 'rpc-servers' was given but this build has no RPC backend "
            "(GGML_RPC was not enabled in qvac-fabric).\n",
            K_LEGACY_PARSER_NAME.data()));
  }

  using AddServerFn = ggml_backend_reg_t (*)(const char* endpoint);
  auto addServer = reinterpret_cast<AddServerFn>(
      ggml_backend_reg_get_proc_address(rpcReg, "ggml_backend_rpc_add_server"));
  if (addServer == nullptr) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        string_format(
            "%s: RPC backend does not export ggml_backend_rpc_add_server.\n",
            K_LEGACY_PARSER_NAME.data()));
  }

  // Optional: connects to every endpoint concurrently before the loop below
  // registers them one at a time. Without this, N endpoints cost N times a
  // full connect (each up to the connect timeout on an unreachable one) even
  // though the endpoints are independent of each other.
  //
  // Deliberately does not change what happens below: registration order (and
  // so RPC0/RPC1/... device numbering) stays exactly as sequential and
  // deterministic as it always was. Only the network wait moves earlier and
  // runs in parallel; addServer() below still assigns device numbers one
  // endpoint at a time, in list order, same as if this block did not exist -
  // it just becomes a cache hit on an already-open connection instead of a
  // fresh connect.
  //
  // A failed connect is NOT cached by get_command_queue() (only successful
  // ones are, so a transient failure gets a fresh retry on the next call
  // rather than being stuck), so addServer() below would otherwise redo the
  // full failing connect a second time, sequentially, for a still-down
  // endpoint - silently reintroducing the same N-times-the-timeout cost this
  // exists to avoid, for the unreachable case specifically. ok[i] records
  // which endpoints already failed during prefetch so the loop below can
  // fail fast on those instead of retrying.
  //
  // Optional because an older qvac-fabric build (predating this addon
  // change) will not export it; ggml_backend_reg_get_proc_address() returns
  // null for an unknown name rather than failing the whole call, so a build
  // without it falls back to today's sequential behavior with no error.
  using PrefetchFn = bool (*)(const char* endpoint);
  auto prefetch =
      reinterpret_cast<PrefetchFn>(ggml_backend_reg_get_proc_address(
          rpcReg, "ggml_backend_rpc_prefetch_connection"));
  // NOT std::vector<bool>: its bits are packed, so writes to two different
  // indices from two different threads can share an underlying word and
  // race. uint8_t elements are genuinely independent memory.
  std::vector<uint8_t> prefetchOk(endpoints.size(), 0);
  bool didPrefetch = false;
  if (prefetch != nullptr) {
    didPrefetch = true;
    std::vector<std::thread> prefetchers;
    prefetchers.reserve(endpoints.size());
    for (size_t i = 0; i < endpoints.size(); i++) {
      // Each thread writes only prefetchOk[i], a distinct element; no shared
      // mutable state is touched, so no synchronization is needed beyond the
      // join() below.
      prefetchers.emplace_back(
          [prefetch, &endpoint = endpoints[i], &ok = prefetchOk[i]]() {
            ok = prefetch(endpoint.c_str()) ? 1 : 0;
          });
    }
    for (std::thread& prefetcher : prefetchers) {
      prefetcher.join();
    }
  }

  std::vector<std::string> deviceNames;
  for (size_t i = 0; i < endpoints.size(); i++) {
    const std::string& endpoint = endpoints[i];
    if (didPrefetch && !prefetchOk[i]) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          string_format(
              "%s: could not reach RPC server '%s'. Check that "
              "ggml-rpc-server is running there and the port is open.\n",
              K_LEGACY_PARSER_NAME.data(),
              endpoint.c_str()));
    }
    ggml_backend_reg_t reg = addServer(endpoint.c_str());
    if (reg == nullptr) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          string_format(
              "%s: could not reach RPC server '%s'. Check that "
              "ggml-rpc-server is running there and the port is open.\n",
              K_LEGACY_PARSER_NAME.data(),
              endpoint.c_str()));
    }
    ggml_backend_register(reg);
    const size_t deviceCount = ggml_backend_reg_dev_count(reg);
    for (size_t deviceIndex = 0; deviceIndex < deviceCount; ++deviceIndex) {
      ggml_backend_dev_t device = ggml_backend_reg_dev_get(reg, deviceIndex);
      const char* name =
          device == nullptr ? nullptr : ggml_backend_dev_name(device);
      if (name == nullptr || *name == '\0') {
        throw qvac_errors::StatusError(
            qvac_errors::general_error::InternalError,
            string_format(
                "%s: RPC server '%s' registered an unnamed device.\n",
                K_LEGACY_PARSER_NAME.data(),
                endpoint.c_str()));
      }
      deviceNames.emplace_back(name);
    }
  }
  return deviceNames;
}

std::string remapRpcDeviceAliases(
    const std::string& devices,
    const std::vector<std::string>& registeredRpcDevices) {
  const std::vector<std::string> requested = split(devices, ',');
  std::string remapped;
  for (const std::string& requestedDevice : requested) {
    std::string resolved = requestedDevice;
    if (requestedDevice.size() > 3 && requestedDevice.rfind("RPC", 0) == 0 &&
        std::ranges::all_of(
            requestedDevice.substr(3), [](unsigned char character) {
              return std::isdigit(character) != 0;
            })) {
      size_t relativeIndex = 0;
      try {
        relativeIndex = std::stoull(requestedDevice.substr(3));
      } catch (const std::exception&) {
        relativeIndex = registeredRpcDevices.size();
      }
      if (relativeIndex >= registeredRpcDevices.size()) {
        throw qvac_errors::StatusError(
            qvac_errors::general_error::InvalidArgument,
            string_format(
                "%s: device '%s' does not exist in this load's rpc-servers "
                "list, which registered %zu RPC device(s).\n",
                K_LEGACY_PARSER_NAME.data(),
                requestedDevice.c_str(),
                registeredRpcDevices.size()));
      }
      resolved = registeredRpcDevices[relativeIndex];
    }
    if (!remapped.empty()) {
      remapped += ',';
    }
    remapped += resolved;
  }
  return remapped;
}

void retainCurrentRpcDevices(
    backend_selection::SplitDeviceSelection& selection,
    const std::vector<std::string>& registeredRpcDevices) {
  const std::unordered_set<std::string> current(
      registeredRpcDevices.begin(), registeredRpcDevices.end());
  std::erase_if(
      selection.devices,
      [&current](const backend_selection::SplitDevice& device) {
        return device.isRpc && !current.contains(device.name);
      });
}

backend_selection::SplitDeviceSelection selectExplicitDevices(
    const backend_selection::SplitDeviceSelection& available,
    const std::string& devices) {
  const std::vector<std::string> requested = split(devices, ',');
  if (requested.empty()) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        string_format(
            "%s: 'devices' is empty; expected a comma-separated list of "
            "ggml device names.\n",
            K_LEGACY_PARSER_NAME.data()));
  }

  backend_selection::SplitDeviceSelection selected;
  selected.sourceGpuCount = available.sourceGpuCount;
  selected.rejectedDevices = available.rejectedDevices;
  selected.devices.reserve(requested.size());
  for (const std::string& name : requested) {
    const auto match = std::ranges::find(
        available.devices, name, &backend_selection::SplitDevice::name);
    if (match == available.devices.end()) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          string_format(
              "%s: device '%s' from 'devices' is not an eligible GPU device "
              "for this load.\n",
              K_LEGACY_PARSER_NAME.data(),
              name.c_str()));
    }
    selected.devices.push_back(*match);
  }
  return selected;
}

std::string
joinDeviceNames(const backend_selection::SplitDeviceSelection& selection) {
  std::string joined;
  for (const backend_selection::SplitDevice& device : selection.devices) {
    if (!joined.empty()) {
      joined += ',';
    }
    joined += device.name;
  }
  return joined;
}

uint32_t trainedContext(const ModelMetaData& metadata) {
  const auto architecture = metadata.tryGetString("general.architecture");
  if (!architecture.has_value()) {
    return 0;
  }
  const std::string key = *architecture + ".context_length";
  return metadata.tryGetU32(key.c_str()).value_or(0);
}

// Mirrors llm_arch_supports_sm_tensor() in qvac-fabric src/llama-arch.cpp,
// which qvac-fabric does not install: it lives in the internal
// src/llama-arch.h, not the public include/ tree. The values below
// are the GGUF `general.architecture` strings from LLM_ARCH_NAMES, NOT the enum
// names lower-cased — e.g. LLM_ARCH_FALCON_H1 is "falcon-h1" and
// LLM_ARCH_GRANITE_HYBRID is "granitehybrid". Deliberately absent, because
// fabric does support them: "deepseek2-ocr" and "t5encoder".
//
// RE-CHECK ON EVERY qvac-fabric BUMP — this is a manual mirror and nothing
// enforces it. LoadFitNormalizationTest.TensorSplitArchDenylistCoversFabric
// exercises this list but reads nothing from fabric, so it cannot detect
// drift; it only pins the addon against its own copy. Verified by hand
// against qvac-fabric v10297.1.1 (27 entries). v10297.1.1 leaves
// src/llama-arch.cpp untouched relative to v10297.1.0, so the list is
// unchanged across that bump.
//
// The bump from v10297.0.0 to v10297.1.0 REMOVED three entries — fabric now
// supports tensor split for deepseek4, qwen35 and qwen35moe. Leaving them here
// would reject architectures fabric accepts, so the list shrank rather than
// grew. A denylist drifts in both directions; re-derive it from
// llm_arch_supports_sm_tensor rather than only appending.
//
// An absent general.architecture returns "supported": fabric's own check at
// src/llama-model.cpp:328 remains the backstop, this list is only a UX layer
// that turns a bare std::runtime_error into a structured InvalidArgument.
bool archSupportsTensorSplit(const ModelMetaData& metadata) {
  static const std::unordered_set<std::string> kUnsupported = {
      "grok",          "mpt",
      "plamo2",        "minicpm3",
      "gemma3n",       "mamba",
      "mamba2",        "jamba",
      "falcon-h1",     "olmo2",
      "olmoe",         "deepseek2",
      "deepseek32",    "glm-dsa",
      "bitnet",        "t5",
      "nemotron_h",    "nemotron_h_moe",
      "granitehybrid", "lfm2",
      "lfm2moe",       "minimax-m2",
      "minimax-m3",    "mistral4",
      "kimi-linear",   "qwen3tts",
      "qwen3next"};
  const auto architecture = metadata.tryGetString("general.architecture");
  if (!architecture.has_value()) {
    return true;
  }
  return kUnsupported.count(*architecture) == 0;
}

// Lambda form rather than a bare ::tolower: the value is caller-supplied and
// may carry non-ASCII bytes, which are negative under a signed char and
// undefined input to tolower.
std::string toLowerAscii(std::string value) {
  std::transform(
      value.begin(), value.end(), value.begin(), [](unsigned char character) {
        return static_cast<char>(std::tolower(character));
      });
  return value;
}

// The resolved flash-attn value, classified against qvac-fabric's own three-way
// vocabulary. Fabric's --flash-attn handler (common/arg.cpp) routes every value
// through is_truthy / is_falsey / is_autoy and throws on anything all three
// reject, so a value outside them is invalid input, NOT a fourth state.
//
// Two flags rather than one because the guards that read this ask DIFFERENT
// questions, and AUTO answers them differently:
//   - "will flash attention definitely be on?"  -> enabled
//   - "might flash attention be on?"            -> mayEnable
struct FlashAttnState {
  bool enabled = false;
  bool mayEnable = false;
};

// Resolves flash-attn from BOTH key spellings, validates it, and classifies it
// once. Callers get a value already checked against fabric's vocabulary, so no
// guard downstream has to decide what an unrecognised string means.
//
// Both spellings present is a hard error. The passthrough loop emits one
// --flash-attn per key and ConfigMap is an unordered_map, so a contradictory
// pair hands fabric two flags whose winner is unspecified — which let a caller
// read as "off" here while fabric applied "auto", disarming the Adreno crash
// guard below. index.d.ts already publishes "Supplying both is an error"; this
// is where that contract is finally enforced, matching what split-mode and
// mmproj-use-gpu already do for their own duplicate spellings.
//
// The value is matched case-SENSITIVELY, deliberately. Fabric's predicates do
// no case folding, so lowercasing here would let the addon act on a value
// fabric then rejects — making this file more permissive than the parser it
// feeds, and replacing fabric's accurate "unknown value" with whatever
// downstream guard happened to fire first.
FlashAttnState resolveFlashAttn(
    const std::unordered_map<std::string, std::string>& configFilemap) {
  const auto hyphenIt = configFilemap.find("flash-attn");
  const auto underscoreIt = configFilemap.find("flash_attn");
  if (hyphenIt != configFilemap.end() && underscoreIt != configFilemap.end()) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        string_format(
            "%s: both 'flash-attn' and 'flash_attn' are present; use one or "
            "the other. Supplying both leaves it unspecified which flash "
            "attention value reaches qvac-fabric.\n",
            K_LEGACY_PARSER_NAME.data()));
  }

  const auto it = (hyphenIt != configFilemap.end()) ? hyphenIt : underscoreIt;
  if (it == configFilemap.end()) {
    return {};
  }

  // is_autoy also accepts "-1", fabric's numeric spelling of AUTO. That is not
  // in index.d.ts's declared union for "flash-attn", and a declared property
  // wins over the [key: string] index signature — so a TypeScript caller can
  // only reach "-1" through the undeclared "flash_attn" spelling. Accepted
  // anyway, because the addon must not disagree with the parser it is about to
  // hand the value to, and direct C++ / JS callers bypass the types entirely.
  const std::string& value = it->second;
  const bool truthy = common_arg_utils::is_truthy(value);
  const bool falsey = common_arg_utils::is_falsey(value);
  const bool autoy = common_arg_utils::is_autoy(value);
  if (!truthy && !falsey && !autoy) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        string_format(
            "%s: unknown value for %s: '%s'. Accepted (lower-case): on, "
            "enabled, true, 1, off, disabled, false, 0, auto.\n",
            K_LEGACY_PARSER_NAME.data(),
            it->first.c_str(),
            value.c_str()));
  }
  return {.enabled = truthy, .mayEnable = truthy || autoy};
}

void remapTensorSplit(
    load_fit_normalization::ConfigMap& config,
    const backend_selection::SplitDeviceSelection& selection,
    const std::optional<size_t> explicitDeviceCount = std::nullopt) {
  auto hyphen = config.find("tensor-split");
  auto underscore = config.find("tensor_split");
  if (hyphen != config.end() && underscore != config.end()) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "both 'tensor-split' and 'tensor_split' are present; use one or the "
        "other.");
  }
  auto value = hyphen != config.end() ? hyphen : underscore;
  if (value == config.end()) {
    return;
  }
  std::string normalized = value->second;
  std::ranges::replace(normalized, '/', ',');
  const std::vector<std::string> proportions = split(normalized, ',');

  // Fabric is handed the tokens counted here, not the caller's string: it keeps
  // empty and blank fields that split() drops, and would reject them.
  auto joinShares = [](const std::vector<std::string>& shares) {
    std::string joined;
    for (const std::string& share : shares) {
      if (!joined.empty()) {
        joined += ',';
      }
      joined += share;
    }
    return joined;
  };

  // An explicit --device list is the final placement set. Validate shares
  // against that list directly rather than the automatically discovered set,
  // which can also contain local GPUs the caller deliberately excluded.
  if (explicitDeviceCount.has_value()) {
    if (proportions.size() != explicitDeviceCount.value()) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          string_format(
              "%s: tensor-split has %zu values, but devices selects %zu "
              "explicit device(s).\n",
              K_LEGACY_PARSER_NAME.data(),
              proportions.size(),
              explicitDeviceCount.value()));
    }
    value->second = joinShares(proportions);
    return;
  }

  // Equal counts resolve to the final order: the addon pins params.devices
  // itself, so fabric applies share i to final device i.
  if (proportions.size() == selection.devices.size()) {
    value->second = joinShares(proportions);
    return;
  }
  if (proportions.size() != selection.sourceGpuCount) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        string_format(
            "%s: tensor-split has %zu values, which matches neither the %zu "
            "registered GPU devices nor the %zu eligible devices.\n",
            K_LEGACY_PARSER_NAME.data(),
            proportions.size(),
            selection.sourceGpuCount,
            selection.devices.size()));
  }
  std::vector<std::string> remapped;
  remapped.reserve(selection.devices.size());
  for (const backend_selection::SplitDevice& device : selection.devices) {
    remapped.push_back(proportions[device.sourceGpuIndex]);
  }
  value->second = joinShares(remapped);
}

} // namespace

namespace load_fit_normalization {

NormalizedFitSnapshot makeNormalizedFitSnapshot(
    const common_params& params, uint32_t trainedContext) {
  NormalizedFitSnapshot snapshot{
      .nGpuLayers = params.n_gpu_layers,
      .nCtx = params.n_ctx == 0 ? trainedContext
                                : static_cast<uint32_t>(params.n_ctx),
      .nBatch = static_cast<uint32_t>(params.n_batch),
      .nUbatch = static_cast<uint32_t>(params.n_ubatch),
      .nParallel = static_cast<uint32_t>(params.n_parallel),
      .splitMode = static_cast<int32_t>(params.split_mode),
      .mainGpu = params.main_gpu,
      .typeK = static_cast<int32_t>(params.cache_type_k),
      .typeV = static_cast<int32_t>(params.cache_type_v),
      .flashAttnType = static_cast<int32_t>(params.flash_attn_type),
      .useMmap = params.load_mode == LLAMA_LOAD_MODE_MMAP ||
                 params.load_mode == LLAMA_LOAD_MODE_MMAP_MLOCK,
      .useMlock = params.load_mode == LLAMA_LOAD_MODE_MLOCK ||
                  params.load_mode == LLAMA_LOAD_MODE_MMAP_MLOCK,
      .kvOffload = !params.no_kv_offload,
      .opOffload = !params.no_op_offload,
      .swaFull = params.swa_full,
      .kvUnified = params.kv_unified,
      .useExtraBufferTypes = !params.no_extra_bufts,
      .useHostBuffer = !params.no_host,
      .fitParams = params.fit_params,
      .fitParamsMinCtx = params.fit_params_min_ctx};

  snapshot.tensorSplit.assign(
      std::begin(params.tensor_split),
      std::begin(params.tensor_split) + llama_max_devices());
  snapshot.fitParamsTargetBytes.assign(
      params.fit_params_target.begin(), params.fit_params_target.end());

  for (const auto& override : params.kv_overrides) {
    if (override.key[0] == '\0') {
      break;
    }
    CanonicalModelKvValue value;
    switch (override.tag) {
    case LLAMA_KV_OVERRIDE_TYPE_INT:
      value = override.val_i64;
      break;
    case LLAMA_KV_OVERRIDE_TYPE_FLOAT:
      value = override.val_f64;
      break;
    case LLAMA_KV_OVERRIDE_TYPE_BOOL:
      value = override.val_bool;
      break;
    case LLAMA_KV_OVERRIDE_TYPE_STR:
      value = std::string(override.val_str);
      break;
    default:
      throw std::invalid_argument("unknown llama model metadata override type");
    }
    snapshot.modelKvOverrides.push_back(
        {.key = override.key,
         .type = static_cast<int32_t>(override.tag),
         .value = std::move(value)});
  }

  for (const auto& override : params.tensor_buft_overrides) {
    if (override.pattern == nullptr) {
      break;
    }
    snapshot.tensorBufferOverrides.push_back(
        {override.pattern,
         override.buft == nullptr ? ""
                                  : ggml_backend_buft_name(override.buft)});
  }
  return snapshot;
}

void tuneLoadConfigMap(
    std::unordered_map<std::string, std::string>& configFilemap,
    const ModelMetaData& metadata, const std::optional<int>& adrenoVersion,
    const FinetuneConfigOverrides& finetuneOverrides, bool isOpenCl,
    bool isMetal, bool isGpu, bool isTensorSplit) {

  const bool isFinetuning = finetuneOverrides.active;

  // Validate the CALLER's value before any default is written on top of it.
  // Order matters: the finetuning branch below erases "flash_attn" and writes
  // "flash-attn", which would silently resolve a contradictory pair instead of
  // rejecting it. The classified result is recomputed after the defaults, so
  // only the validation side effect is wanted here.
  static_cast<void>(resolveFlashAttn(configFilemap));

  auto notUserSet = [&](const char* hyphenKey, const char* underscoreKey) {
    return configFilemap.find(hyphenKey) == configFilemap.end() &&
           configFilemap.find(underscoreKey) == configFilemap.end();
  };

  const bool isBitnet =
      metadata.hasOneBitQuantization() &&
      metadata.tryGetString("general.architecture") == "bitnet";

  if (isFinetuning) {
    configFilemap.erase("ctx_size");
    configFilemap["ctx-size"] = std::to_string(finetuneOverrides.contextLength);
    configFilemap.erase("batch_size");
    configFilemap["batch-size"] = std::to_string(finetuneOverrides.batchSize);
    configFilemap.erase("ubatch_size");
    configFilemap["ubatch-size"] =
        std::to_string(finetuneOverrides.microBatchSize);
    QLOG_IF(
        Priority::DEBUG,
        string_format(
            "[LlamaModel] Finetuning: ctx-size=%" PRId64 " batch-size=%" PRId64
            " ubatch-size=%" PRId64 "\n",
            finetuneOverrides.contextLength,
            finetuneOverrides.batchSize,
            finetuneOverrides.microBatchSize));
  }

  if (isFinetuning) {
    configFilemap.erase("flash_attn");
    configFilemap["flash-attn"] = finetuneOverrides.flashAttn ? "on" : "off";
    QLOG_IF(
        Priority::INFO,
        (finetuneOverrides.flashAttn
             ? "[LlamaModel] Finetuning: enabling flash attention\n"
             : "[LlamaModel] Finetuning: disabling flash attention\n"));
  } else if (isBitnet && notUserSet("flash-attn", "flash_attn")) {
    configFilemap.erase("flash_attn");
    configFilemap["flash-attn"] = "off";
    QLOG_IF(
        Priority::INFO,
        "[LlamaModel] BitNet model detected: disabling flash attention\n");
  } else if (notUserSet("flash-attn", "flash_attn")) {
    configFilemap.erase("flash_attn");
    configFilemap["flash-attn"] = "on";
    QLOG_IF(
        Priority::INFO, "[LlamaModel] Enabling flash attention by default\n");
  }

  constexpr int kAdrenoUbatchThreshold = 800;
  const bool needsUbatch = (isBitnet || isFinetuning) &&
                           adrenoVersion.has_value() &&
                           adrenoVersion.value() >= kAdrenoUbatchThreshold;
  if (needsUbatch) {
    constexpr int64_t kAdrenoUbatchCap = 128;
    if (notUserSet("ubatch-size", "ubatch_size")) {
      configFilemap["ubatch-size"] = std::to_string(kAdrenoUbatchCap);
      QLOG_IF(
          Priority::INFO,
          "[LlamaModel] Adreno 800+ (Vulkan): defaulting ubatch-size=128\n");
    } else {
      const std::string& key =
          configFilemap.count("ubatch-size") ? "ubatch-size" : "ubatch_size";
      int64_t userVal;
      try {
        userVal = std::stoll(configFilemap[key]);
      } catch (const std::exception& e) {
        QLOG_IF(
            Priority::ERROR,
            string_format(
                "[LlamaModel] Adreno 800+ (Vulkan): invalid ubatch-size "
                "\"%s\" (%s), falling back to %" PRId64 "\n",
                configFilemap[key].c_str(),
                e.what(),
                kAdrenoUbatchCap));
        userVal = kAdrenoUbatchCap;
      }
      const int64_t clamped = std::min(userVal, kAdrenoUbatchCap);
      if (clamped < userVal) {
        QLOG_IF(
            Priority::WARNING,
            string_format(
                "[LlamaModel] Adreno 800+ (Vulkan): ubatch-size=%" PRId64
                " exceeds safe maximum %" PRId64 ", clamping to %" PRId64 "\n",
                userVal,
                kAdrenoUbatchCap,
                clamped));
      }
      configFilemap.erase("ubatch_size");
      configFilemap["ubatch-size"] = std::to_string(clamped);
    }
  }

  if (isFinetuning && !finetuneOverrides.gpuSupportsF16OutProd) {
    if (notUserSet("cache-type-k", "cache_type_k")) {
      configFilemap["cache-type-k"] = "f32";
      QLOG_IF(
          Priority::INFO,
          "[LlamaModel] Finetuning: GPU lacks F16 out_prod, using f32 K for KV "
          "cache\n");
    }
    if (notUserSet("cache-type-v", "cache_type_v")) {
      configFilemap["cache-type-v"] = "f32";
      QLOG_IF(
          Priority::INFO,
          "[LlamaModel] Finetuning: GPU lacks F16 out_prod, using f32 V for KV "
          "cache\n");
    }
  }

  // QVAC-21318: KV-cache type policy. Blocks 1-3 run in a fixed order that MUST
  // NOT be reordered; block 4 is an order-independent advisory:
  //   1. auto-default q8_0 on GPU   — fills in the default when unset
  //   2. Adreno 800+ Vulkan reject  — rejects quantized KV that would crash
  //   3. OpenCL / Metal guard       — validates the (possibly defaulted) type
  //   4. mixed K!=V warning         — advisory only, never throws
  // The finetuning f32 KV override above runs first; the auto-default is gated
  // by !isFinetuning so it never clobbers it.
  //
  // Shared inputs, computed once. Re-resolved rather than reusing the caller's
  // classification above, because the branches in between may have written the
  // effective value (the "on" default, BitNet's and finetuning's force-off) —
  // this must read what fabric will actually receive.
  constexpr int kAdrenoKvQuantThreshold = 800;
  const FlashAttnState flashAttn = resolveFlashAttn(configFilemap);

  // Two questions, not one, because the guards below differ on AUTO.
  //
  // flashAttnEnabled — "flash attention will definitely be on". Truthy only,
  // with one exception. AUTO is otherwise excluded because the q8_0 default it
  // gates quantizes the V cache, and fabric promotes AUTO to ENABLED whenever
  // the V cache is quantized (src/llama-context.cpp, "enabling flash_attn
  // since it is required for quantized V cache"). Defaulting q8_0 for an AUTO
  // caller would force flash attention on and skip the runtime capability
  // probe (llama_context::resolve, cparams.auto_fa) that AUTO exists to run —
  // contradicting this package's documented contract, "'auto' lets qvac-fabric
  // decide" (src/index.ts). An AUTO caller keeps f16; an explicit
  // cache-type-k/v still works.
  //
  // The exception is split-mode 'tensor'. Fabric promotes AUTO to ENABLED for
  // that mode unconditionally and before any KV type is read
  // (src/llama-context.cpp, "enabling flash_attn since it is required for
  // SPLIT_MODE_TENSOR"), so there is no probe left to protect and withholding
  // q8_0 would cost 2x the KV cache for nothing. It lands worst there too:
  // tensor mode force-disables auto-fit, so nothing trims ctx_size to absorb
  // it. Falsey under tensor mode is rejected outright by the guard in
  // normalizeLoadForFit, so it cannot reach the q8_0 block either way.
  //
  // flashAttnMayEnable — "flash attention might be on". Truthy or autoy. The
  // Adreno crash guard is defence-in-depth against a native abort, so it must
  // fire for any value that can reach fabric with flash attention active, and
  // AUTO can: quantized V promotes it to ENABLED, and even an un-promoted AUTO
  // resolves to enabled wherever the probe passes. Deliberately conservative —
  // with a quantized K cache only no promotion fires and the probe might have
  // disabled flash attention on its own, but the guard runs long before the
  // probe and cannot know the outcome.
  const bool flashAttnEnabled =
      flashAttn.enabled || (isTensorSplit && flashAttn.mayEnable);
  const bool flashAttnMayEnable = flashAttn.mayEnable;
  // Adreno 800+ on Vulkan: coopmat1 Flash Attention is unstable with quantized
  // KV (no fabric scalar-FA fix on this branch). Adreno selects OpenCL by
  // default, so this is normally unreachable; kept as a defensive guard against
  // forced-Vulkan paths. Requires isGpu so a non-GPU call can't fire it.
  const bool isAdrenoVulkan =
      isGpu && adrenoVersion.has_value() &&
      adrenoVersion.value() >= kAdrenoKvQuantThreshold && !isOpenCl && !isMetal;
  auto isQuantizedKvType = [](const std::string& v) {
    return v == "q4_0" || v == "q4_1" || v == "q5_0" || v == "q5_1" ||
           v == "q8_0" || v == "iq4_nl" || v == "tbq3_0" || v == "tbq4_0" ||
           v == "pq3_0" || v == "pq4_0";
  };

  // 1. Default the KV-cache to q8_0 on Metal/Vulkan GPU backends when the
  // caller hasn't picked a cache type. q8_0 is quality-neutral vs f16 on GPU
  // and cuts KV-cache memory ~47%. CPU keeps the f16 default — ARM q8_0 carries
  // a measured quality and decode-throughput cost. OpenCL (Adreno) is also
  // EXCLUDED: q8_0 attention works there, but quantized KV-cache *shifts*
  // (reasoning-block compaction / state restore) abort natively in
  // llama_kv_cache::update on Adreno, so f16 stays the safe default — and
  // block 3 now *rejects* any explicit quantized KV on OpenCL (q8_0 and q4_0
  // both crash on a shift). Also skipped for finetuning (manages its own KV
  // types), when flash attention is off (V-cache quantization requires it), and
  // on Adreno+Vulkan (see above).
  if (!isFinetuning && isGpu && !isOpenCl && flashAttnEnabled &&
      !isAdrenoVulkan && notUserSet("cache-type-k", "cache_type_k") &&
      notUserSet("cache-type-v", "cache_type_v")) {
    configFilemap["cache-type-k"] = "q8_0";
    configFilemap["cache-type-v"] = "q8_0";
    QLOG_IF(
        Priority::INFO,
        "[LlamaModel] Defaulting KV-cache to q8_0 on GPU backend "
        "(set cache-type-k/v to override)\n");
  }

  // 2. Adreno 800+ Vulkan: quantized KV-cache with Flash Attention crashes (the
  // FA CM2 shader's dequant path hits an Adreno driver bug). Guard here so
  // callers get a clean error instead of a native abort.
  if (isAdrenoVulkan && flashAttnMayEnable) {
    auto checkAdrenoKv = [&](const char* hyphenKey,
                             const char* underscoreKey,
                             const char* side) {
      auto it = configFilemap.find(hyphenKey);
      if (it == configFilemap.end())
        it = configFilemap.find(underscoreKey);
      if (it == configFilemap.end())
        return;
      if (!isQuantizedKvType(it->second))
        return;
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          string_format(
              "[LlamaModel] cache-type-%s=%s: quantized KV-cache with "
              "Flash Attention is not supported on Adreno 800+ (Vulkan). "
              "Use flash-attn=off, set cache-type-%s to f16/f32/bf16, or "
              "disable GPU acceleration.\n",
              side,
              it->second.c_str(),
              side));
    };
    checkAdrenoKv("cache-type-k", "cache_type_k", "k");
    checkAdrenoKv("cache-type-v", "cache_type_v", "v");
  }

  // 3. OpenCL (Adreno): reject ALL quantized KV-cache types. q4_0/q8_0
  // attention works, but a quantized K cache needs a
  // dequantize->RoPE->requantize copy on every KV-cache *shift* (reasoning-
  // block compaction / state restore), and ggml-opencl has no F32->quantized
  // copy kernel for that requantize step, so the shift aborts natively in
  // llama_kv_cache::update on Adreno. Confirmed for BOTH q8_0 and q4_0 (CI run
  // 28448086915: S25/S26 crash on a q4_0 KV-cache shift; Mali Vulkan passes).
  // Only f32/f16/bf16 are safe on OpenCL. Metal: standard quant types are
  // supported; only TurboQuant/PolarQuant is rejected.
  if (isOpenCl || isMetal) {
    auto isTurboQuantKvType = [](const std::string& v) {
      return v == "tbq3_0" || v == "tbq4_0" || v == "pq3_0" || v == "pq4_0";
    };
    auto isOpenClSafeKvType = [](const std::string& v) {
      return v == "f32" || v == "f16" || v == "bf16";
    };
    auto checkCacheType = [&](const char* hyphenKey,
                              const char* underscoreKey,
                              const char* side) {
      auto it = configFilemap.find(hyphenKey);
      if (it == configFilemap.end())
        it = configFilemap.find(underscoreKey);
      if (it == configFilemap.end())
        return;
      if (isOpenCl) {
        if (isOpenClSafeKvType(it->second))
          return;
        // TurboQuant/PolarQuant: no OpenCL kernel at all. Keep the
        // "TurboQuant/PolarQuant ... not supported" wording so callers can
        // recognize it specifically.
        if (isTurboQuantKvType(it->second)) {
          throw qvac_errors::StatusError(
              qvac_errors::general_error::InvalidArgument,
              string_format(
                  "[LlamaModel] cache-type-%s=%s is a TurboQuant/PolarQuant "
                  "KV-cache type and is not supported on the OpenCL (Adreno) "
                  "backend. Use cache-type-%s f32/f16/bf16, or switch device "
                  "to "
                  "a Vulkan GPU or CPU.\n",
                  side,
                  it->second.c_str(),
                  side));
        }
        // Any other quantized type on OpenCL: the requantize copy on a KV-cache
        // shift has no ggml-opencl kernel and aborts in llama_kv_cache::update.
        // The wording covers both sides — this check runs for K and V alike.
        throw qvac_errors::StatusError(
            qvac_errors::general_error::InvalidArgument,
            string_format(
                "[LlamaModel] cache-type-%s=%s: quantized KV-cache is not "
                "supported on the OpenCL (Adreno) backend. A quantized K or V "
                "cache aborts in llama_kv_cache::update on KV-cache shifts / "
                "cache management (reasoning-block compaction, state restore), "
                "because ggml-opencl has no F32->quantized copy kernel for the "
                "requantize step (true for q8_0 and q4_0 alike). Use "
                "cache-type-%s f32/f16/bf16, or switch device to a Vulkan GPU "
                "or CPU.\n",
                side,
                it->second.c_str(),
                side));
      }
      // Metal: only TurboQuant/PolarQuant is unsupported.
      if (!isTurboQuantKvType(it->second))
        return;
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          string_format(
              "[LlamaModel] cache-type-%s=%s is a TurboQuant/PolarQuant "
              "KV-cache type and is not supported on the Metal backend. Either "
              "pick a different cache type "
              "(f32/f16/bf16/q4_0/q4_1/q5_0/q5_1/q8_0/iq4_nl) or switch device "
              "to a Vulkan GPU or CPU.\n",
              side,
              it->second.c_str()));
    };
    checkCacheType("cache-type-k", "cache_type_k", "k");
    checkCacheType("cache-type-v", "cache_type_v", "v");
  }

  // 4. Mixed/asymmetric K!=V warning (advisory — never throws). When K and V
  // use different cache types and at least one is quantized, the kernels fall
  // off the fused Flash-Attention path (a large GPU decode penalty on
  // Vulkan/Mali) for no quality benefit. Asymmetric non-quantized
  // (f32/f16/bf16) carries no such penalty and is not warned. Finetuning
  // manages its own KV types, so it is skipped. This is a warning, not a hard
  // error — callers may still opt in — and can be removed once qvac-fabric
  // handles asymmetric quantized K/V efficiently.
  if (!isFinetuning) {
    auto effectiveType = [&](const char* hyphenKey, const char* underscoreKey) {
      auto it = configFilemap.find(hyphenKey);
      if (it == configFilemap.end())
        it = configFilemap.find(underscoreKey);
      return it == configFilemap.end() ? std::string("f16") : it->second;
    };
    const std::string kType = effectiveType("cache-type-k", "cache_type_k");
    const std::string vType = effectiveType("cache-type-v", "cache_type_v");
    if (kType != vType &&
        (isQuantizedKvType(kType) || isQuantizedKvType(vType))) {
      QLOG_IF(
          Priority::WARNING,
          string_format(
              "[LlamaModel] Mixed KV-cache types (cache-type-k=%s, "
              "cache-type-v=%s): asymmetric quantized K/V falls off the fused "
              "Flash-Attention path (notable GPU decode-throughput penalty on "
              "Vulkan/Mali) with no quality benefit, and is unsupported on "
              "Adreno OpenCL. Proceeding anyway; prefer a symmetric cache "
              "type. "
              "(This may be relaxed once qvac-fabric handles asymmetric "
              "quantized K/V efficiently.)\n",
              kType.c_str(),
              vType.c_str()));
    }
  }
}

NormalizationDependencies
productionDependencies(backend_selection::llamaLogCallbackF logCallback) {
  return {
      .resolveBackend =
          [logCallback](
              backend_selection::BackendType preferred,
              const std::optional<backend_selection::MainGpu>& mainGpu,
              const ModelMetaData& metadata,
              bool isFinetuning) {
            std::optional<int> adrenoVersion;
            bool isMaliGpu = false;
            auto [type, name] = backend_selection::chooseBackend(
                preferred,
                logCallback,
                mainGpu,
                &metadata,
                &adrenoVersion,
                isFinetuning,
                &isMaliGpu);
            const bool isOpenCl = name.find("opencl") != std::string::npos;
            const bool isMetal = name.find("metal") != std::string::npos ||
                                 name.rfind("mtl", 0) == 0;
            return SelectedBackend{
                .type = type,
                .name = std::move(name),
                .adrenoVersion = adrenoVersion,
                .isMaliGpu = isMaliGpu,
                .isOpenCl = isOpenCl,
                .isMetal = isMetal};
          },
      .splitDevices =
          []() { return backend_selection::getSplitDeviceSelection(); },
      .registerRpcDevices =
          [](const std::string& servers) {
            return ::registerRpcDevices(servers);
          }};
}

void validateMobileMultiDeviceConfig(
    const ConfigMap& configFilemap, llama_split_mode splitMode) {
  const bool hasRpcConfig = configFilemap.count("rpc-servers") > 0 ||
                            configFilemap.count("rpc_servers") > 0 ||
                            configFilemap.count("rpc") > 0;
  auto devicesIt = configFilemap.find("devices");
  if (devicesIt == configFilemap.end()) {
    devicesIt = configFilemap.find("device-list");
  }
  const bool hasExplicitDeviceList =
      devicesIt != configFilemap.end() && !devicesIt->second.empty();
  const bool hasMainGpu = configFilemap.count("main-gpu") > 0 ||
                          configFilemap.count("main_gpu") > 0;
  const bool hasTensorSplit = configFilemap.count("tensor-split") > 0 ||
                              configFilemap.count("tensor_split") > 0;

  if (hasRpcConfig) {
    if (!hasExplicitDeviceList) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          "Distributed inference (rpc-servers) on mobile requires a non-empty "
          "devices list, e.g. 'RPC0' or 'RPC0,RPC1'.");
    }
    if (hasMainGpu) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          "main-gpu is not supported with rpc-servers on mobile; set devices "
          "explicitly instead.");
    }
    return;
  }

  if (splitMode != LLAMA_SPLIT_MODE_NONE || hasMainGpu || hasTensorSplit) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "Multi-GPU parameters (split-mode, main-gpu, tensor-split) are not "
        "supported on mobile without rpc-servers (single-GPU device).");
  }
  // An explicit device list overrides the mobile backend selection and the
  // tuning derived from it. Keep it reserved for RPC placement, where the
  // caller must name the remote devices explicitly.
  if (devicesIt != configFilemap.end()) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "Explicit device lists (devices) are only supported on mobile when "
        "rpc-servers is set.");
  }
}

NormalizedLoad normalizeLoadForFit(
    const std::string& modelPath, ConfigMap configFilemap,
    const ModelMetaData& metadata,
    const FinetuneConfigOverrides& finetuneOverrides,
    const NormalizationDependencies& dependencies) {
  NormalizedLoad result;
  common_params& params = result.params;

  std::vector<std::string> configVector;

  // Check if tools are enabled and exclude it with jinja from the config file
  if (auto iter = configFilemap.find("tools"); iter != configFilemap.end()) {
    const std::string toolsVal = toLowerAscii(iter->second);
    if (toolsVal == "true") {
      params.use_jinja = true;
      // Remove "tools" from config, since using jinja
      configFilemap.erase(iter);
    } else {
      configFilemap.erase(iter);
    }
  }
  if (auto jit = configFilemap.find("jinja"); jit != configFilemap.end()) {
    // Remove "jinja" from config
    configFilemap.erase(jit);
  }

  // Map the addon's load-mode string configuration directly to the native
  // model parameter (the generic argument parser is bypassed for it). The
  // accepted values mirror llama_load_mode_from_str: 'none', 'mmap',
  // 'mlock', 'mmap+mlock' and 'dio'. When absent, llama.cpp's default
  // (mmap) applies. Validated with a local table instead of
  // llama_load_mode_from_str: that helper reports unknown values by throwing
  // std::invalid_argument, and exceptions thrown inside the fabric DLL do
  // not reliably match catch-by-type across the module boundary on Windows.
  std::optional<std::string> loadMode;
  for (const std::string& key : {"load-mode", "load_mode"}) {
    if (auto it = configFilemap.find(key); it != configFilemap.end()) {
      // fabric's deprecated mmap / direct-io flags assign params.load_mode too,
      // and the generic loop runs after this block, so one of them would
      // silently overwrite the mode validated here.
      for (const std::string& alias :
           {"mmap",
            "no-mmap",
            "no_mmap",
            "direct-io",
            "direct_io",
            "no-direct-io",
            "no_direct_io"}) {
        if (configFilemap.contains(alias)) {
          throw qvac_errors::StatusError(
              ADDON_ID,
              qvac_errors::general_error::toString(
                  qvac_errors::general_error::InvalidArgument),
              string_format(
                  "%s: '%s' cannot be combined with '%s'; use one or the "
                  "other.\n",
                  K_LEGACY_PARSER_NAME.data(),
                  key.c_str(),
                  alias.c_str()));
        }
      }
      const std::string value = toLowerAscii(it->second);
      if (loadMode.has_value() && loadMode.value() != value) {
        throw qvac_errors::StatusError(
            ADDON_ID,
            qvac_errors::general_error::toString(
                qvac_errors::general_error::InvalidArgument),
            "load-mode and load_mode must have the same value");
      }
      loadMode = value;
      configFilemap.erase(it);
    }
  }
  if (loadMode.has_value()) {
    static const std::unordered_map<std::string, llama_load_mode> kLoadModes = {
        {"auto", LLAMA_LOAD_MODE_AUTO},
        {"none", LLAMA_LOAD_MODE_NONE},
        {"mmap", LLAMA_LOAD_MODE_MMAP},
        {"mlock", LLAMA_LOAD_MODE_MLOCK},
        {"mmap+mlock", LLAMA_LOAD_MODE_MMAP_MLOCK},
        {"dio", LLAMA_LOAD_MODE_DIRECT_IO}};
    const auto mode = kLoadModes.find(loadMode.value());
    if (mode == kLoadModes.end()) {
      throw qvac_errors::StatusError(
          ADDON_ID,
          qvac_errors::general_error::toString(
              qvac_errors::general_error::InvalidArgument),
          string_format(
              "load-mode must be one of 'auto', 'none', 'mmap', 'mlock', "
              "'mmap+mlock' or 'dio', got: %s",
              loadMode->c_str()));
    }
    params.load_mode = mode->second;
  }

  // The deprecated mmap and direct-io flags are separate options that both
  // assign params.load_mode, and llama_load_mode is a flat selector rather
  // than a bitfield, so the generic loop would let whichever ran last erase
  // the other. Flags agreeing on a mode are left to it.
  struct DeprecatedLoadFlag {
    const char* key;
    bool isPositive;
    llama_load_mode enabled;
  };
  static constexpr DeprecatedLoadFlag kDeprecatedLoadFlags[] = {
      {"mmap", true, LLAMA_LOAD_MODE_MMAP},
      {"no-mmap", false, LLAMA_LOAD_MODE_MMAP},
      {"no_mmap", false, LLAMA_LOAD_MODE_MMAP},
      {"direct-io", true, LLAMA_LOAD_MODE_DIRECT_IO},
      {"direct_io", true, LLAMA_LOAD_MODE_DIRECT_IO},
      {"no-direct-io", false, LLAMA_LOAD_MODE_DIRECT_IO},
      {"no_direct_io", false, LLAMA_LOAD_MODE_DIRECT_IO}};

  std::optional<llama_load_mode> deprecatedMode;
  const char* deprecatedKey = nullptr;
  for (const auto& flag : kDeprecatedLoadFlags) {
    const auto it = configFilemap.find(flag.key);
    if (it == configFilemap.end()) {
      continue;
    }
    bool requested = true;
    if (!it->second.empty()) {
      if (common_arg_utils::is_truthy(it->second)) {
        requested = true;
      } else if (common_arg_utils::is_falsey(it->second)) {
        requested = false;
      } else {
        // The generic loop reports the unknown value against the key itself.
        continue;
      }
    }
    const llama_load_mode mode =
        flag.isPositive == requested ? flag.enabled : LLAMA_LOAD_MODE_NONE;
    if (deprecatedMode.has_value() && deprecatedMode.value() != mode) {
      throw qvac_errors::StatusError(
          ADDON_ID,
          qvac_errors::general_error::toString(
              qvac_errors::general_error::InvalidArgument),
          string_format(
              "%s: '%s' and '%s' select different load modes; use 'load-mode' "
              "instead.\n",
              K_LEGACY_PARSER_NAME.data(),
              deprecatedKey,
              flag.key));
    }
    deprecatedMode = mode;
    deprecatedKey = flag.key;
  }

  // MedPsy ships only a Jinja chat template embedded in its GGUF; the non-jinja
  // fallback path used by llama.cpp does not execute the {%- set persona -%}
  // block that injects the model's persona system prompt, so the model loses
  // its identity when jinja is off. Auto-enable jinja whenever we detect the
  // MedPsy basename so the embedded template is applied regardless of the
  // tools setting.
  if (!params.use_jinja &&
      qvac_lib_inference_addon_llama::utils::isMedPsyBasename(
          metadata.tryGetString("general.basename").value_or(""))) {
    params.use_jinja = true;
    QLOG_IF(
        Priority::INFO,
        "[LlamaModel] MedPsy basename detected; auto-enabling jinja so the "
        "embedded chat template is applied\n");
  }

  // Skip the projector's audio encoder by default.
  params.mmproj_no_audio = true;

  qvac_lib_inference_addon_llama::applyLoadConfigHandlers(
      params, configFilemap);

  llama_split_mode splitMode = LLAMA_SPLIT_MODE_NONE;
  if (auto it =
          findOneOfAliasedKeys(configFilemap, {"split-mode", "split_mode"});
      it != configFilemap.end()) {
    const std::string val = toLowerAscii(it->second);
    if (val == "layer") {
      splitMode = LLAMA_SPLIT_MODE_LAYER;
    } else if (val == "tensor") {
      splitMode = LLAMA_SPLIT_MODE_TENSOR;
    } else if (val == "row") {
      // Row split needs split buffers, which only SYCL provides and this addon
      // does not allow; rejected rather than silently degraded to 'layer'.
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          string_format(
              "%s: split-mode 'row' is no longer accepted; it never took "
              "effect "
              "on any shipped backend. Use 'layer' or 'tensor' (accepted "
              "values: 'none', 'layer', 'tensor').\n",
              K_LEGACY_PARSER_NAME.data()));
    } else if (val != "none") {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          string_format(
              "%s: invalid split-mode '%s', must be 'none', 'layer', or "
              "'tensor'.\n",
              K_LEGACY_PARSER_NAME.data(),
              it->second.c_str()));
    }
    configFilemap.erase(it);
  }

#if defined(__ANDROID__) ||                                                    \
    (defined(__APPLE__) && defined(TARGET_OS_IOS) && TARGET_OS_IOS)
  validateMobileMultiDeviceConfig(configFilemap, splitMode);
#endif

  // Set when this load registered RPC devices, so the CPU-fallback branch
  // below can tell "no RPC involved" apart from "RPC involved, but automatic
  // selection could not place it" — the latter must fail loudly rather than
  // silently run everything locally.
  bool rpcDevicesRegistered = false;

  auto deviceIt = configFilemap.find("device");
  if (deviceIt == configFilemap.end()) {
    std::string errorMsg = string_format(
        "%s: must specify a device: 'gpu' or 'cpu'.\n",
        K_LEGACY_PARSER_NAME.data());
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument, errorMsg);
  }

  const backend_selection::BackendType preferredBackend =
      backend_selection::preferredBackendTypeFromString(deviceIt->second);

  // Ordering contract: this must run *after* the 'device' lookup, so
  // device:'cpu' can reject RPC before opening sockets, but *before*
  // resolveBackend() below, because RPC devices only exist in the ggml registry
  // once they are added here. It must also run after the mobile guard above,
  // which rejects local-only multi-device config while allowing explicit RPC
  // placement.
  //
  // The key is erased on use: the passthrough loop further down forwards every
  // remaining key to llama.cpp as '--<key> <value>', and a surviving 'rpc' key
  // would make its parser register the same endpoints a second time.
  //
  // 'rpc' is accepted as an alias because it is llama.cpp's own flag name.
  // Handling it here rather than letting the passthrough loop forward it as
  // --rpc matters: qvac-fabric's own handler calls ggml_backend_load_all(),
  // which would re-load backends from the default path (see
  // registerRpcDevices).
  std::vector<std::string> registeredRpcDevices;
  if (auto it = findOneOfAliasedKeys(
          configFilemap, {"rpc-servers", "rpc_servers", "rpc"});
      it != configFilemap.end()) {
    if (preferredBackend == backend_selection::BackendType::CPU) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          string_format(
              "%s: 'rpc-servers' requires device: 'gpu'; device: 'cpu' runs "
              "entirely on the local CPU.\n",
              K_LEGACY_PARSER_NAME.data()));
    }
    registeredRpcDevices = dependencies.registerRpcDevices(it->second);
    rpcDevicesRegistered = true;
    configFilemap.erase(it);
  }

  // Hoisted alongside 'rpc-servers' rather than parsed where it is used below,
  // so the CPU-fallback branch can consult it: a caller who named devices
  // explicitly has already told us what to use, and that must not be
  // silently overridden by automatic selection failing to find a local GPU.
  std::string explicitDevices;
  if (auto it = findOneOfAliasedKeys(configFilemap, {"devices", "device-list"});
      it != configFilemap.end()) {
    explicitDevices = it->second;
    if (rpcDevicesRegistered) {
      explicitDevices =
          remapRpcDeviceAliases(explicitDevices, registeredRpcDevices);
    }
    configFilemap.erase(it);
  }

  bool isOpenCl = false;
  bool isMetal = false;
  bool isGpu = false;
  {
    using namespace backend_selection;
    const std::optional<MainGpu> mainGpu = tryMainGpuFromMap(configFilemap);

    backend_selection::SplitDeviceSelection splitSelection;
    SelectedBackend selected;
    std::optional<int> mmprojAdrenoVersion;
    if (preferredBackend == BackendType::GPU &&
        (splitMode != LLAMA_SPLIT_MODE_NONE || !explicitDevices.empty())) {
      splitSelection = dependencies.splitDevices();
      if (rpcDevicesRegistered) {
        retainCurrentRpcDevices(splitSelection, registeredRpcDevices);
      }
      const backend_selection::SplitDeviceSelection availableSelection =
          splitSelection;
      if (!explicitDevices.empty()) {
        splitSelection =
            selectExplicitDevices(availableSelection, explicitDevices);
        // Fabric's NONE mode is single-device: it keeps only main_gpu from
        // the supplied list. Explicit device order owns placement here, so
        // index zero is authoritative. Mirror that before deriving traits so
        // unused explicit entries cannot constrain tuning.
        if (splitMode == LLAMA_SPLIT_MODE_NONE &&
            splitSelection.devices.size() > 1) {
          splitSelection.devices.resize(1);
        }
      }
      // This path never calls chooseBackend, so apply its Adreno restrictions
      // to the split set; an emptied list falls through to the CPU branch.
      const size_t explicitDeviceCount = splitSelection.devices.size();
      backend_selection::applyAdrenoRestrictions(
          splitSelection, metadata, finetuneOverrides.active);
      if (!explicitDevices.empty() &&
          splitSelection.devices.size() != explicitDeviceCount) {
        throw qvac_errors::StatusError(
            qvac_errors::general_error::InvalidArgument,
            string_format(
                "%s: one or more explicitly selected devices are not "
                "supported for this model or workload.\n",
                K_LEGACY_PARSER_NAME.data()));
      }
      if (!explicitDevices.empty()) {
        explicitDevices = joinDeviceNames(splitSelection);
      }
      if (!splitSelection.devices.empty()) {
        // Placement traits come only from the final participating set. The
        // projector uses its first local device, falling back to the first
        // available local device when placement is RPC-only because RPC
        // cannot host the projector.
        const auto& devices = splitSelection.devices;
        const auto localParticipant = std::ranges::find_if(
            devices, [](const backend_selection::SplitDevice& device) {
              return !device.isRpc;
            });
        const backend_selection::SplitDevice* projector =
            localParticipant != devices.end() ? &*localParticipant : nullptr;
        if (projector == nullptr) {
          const auto localFallback = std::ranges::find_if(
              availableSelection.devices,
              [](const backend_selection::SplitDevice& device) {
                return !device.isRpc;
              });
          if (localFallback != availableSelection.devices.end()) {
            projector = &*localFallback;
          }
        }
        const backend_selection::SplitDevice& primary =
            projector != nullptr ? *projector : devices.front();
        mmprojAdrenoVersion = primary.adrenoVersion;
        const auto anyDevice =
            [&devices](bool backend_selection::SplitDevice::* trait) {
              return std::ranges::any_of(
                  devices, [trait](const backend_selection::SplitDevice& d) {
                    return d.*trait;
                  });
            };
        std::optional<int> maxAdrenoVersion;
        for (const backend_selection::SplitDevice& device : devices) {
          if (!device.isRpc && device.adrenoVersion.has_value() &&
              (!maxAdrenoVersion.has_value() ||
               device.adrenoVersion.value() > maxAdrenoVersion.value())) {
            maxAdrenoVersion = device.adrenoVersion;
          }
        }
        selected = {
            .type = BackendType::GPU,
            .name = primary.name,
            .adrenoVersion = maxAdrenoVersion,
            .isOpenCl = anyDevice(&backend_selection::SplitDevice::isOpenCl),
            .isMetal = anyDevice(&backend_selection::SplitDevice::isMetal)};
      } else if (!splitSelection.rejectedDevices.empty()) {
        std::string rejected;
        for (const std::string& device : splitSelection.rejectedDevices) {
          if (!rejected.empty()) {
            rejected += ", ";
          }
          rejected += device;
        }
        QLOG_IF(
            Priority::WARNING,
            string_format(
                "[LlamaModel] no eligible GPU backend found; rejected %s; "
                "falling back to CPU\n",
                rejected.c_str()));
      }
    } else {
      selected = dependencies.resolveBackend(
          preferredBackend, mainGpu, metadata, finetuneOverrides.active);
      mmprojAdrenoVersion = selected.adrenoVersion;
    }
    result.adrenoVersion = selected.adrenoVersion;

    // QVAC-21257: optional runtime override for the multimodal projector
    // (mmproj / vision encoder) backend. The default is auto-selected per
    // device class (QVAC-21867): desktop / iOS -> GPU; Android -> GPU except
    // Mali, whose projector encode is slower on GPU than CPU -> CPU. The key
    // lets callers force either backend without recompiling.
    // Accepts true/on/1 and false/off/0 (case-insensitive). Erased from
    // configFilemap so it is never forwarded to llama.cpp's argument parser
    // by the passthrough loop.
    std::optional<bool> mmprojUseGpuOverride;
    if (auto it = findOneOfAliasedKeys(
            configFilemap, {"mmproj-use-gpu", "mmproj_use_gpu"});
        it != configFilemap.end()) {
      std::string val = it->second;
      std::transform(val.begin(), val.end(), val.begin(), ::tolower);
      if (val == "true" || val == "on" || val == "1") {
        mmprojUseGpuOverride = true;
      } else if (val == "false" || val == "off" || val == "0") {
        mmprojUseGpuOverride = false;
      } else {
        throw qvac_errors::StatusError(
            qvac_errors::general_error::InvalidArgument,
            string_format(
                "%s: invalid mmproj-use-gpu '%s', must be 'true'/'on'/'1' or "
                "'false'/'off'/'0'.\n",
                K_LEGACY_PARSER_NAME.data(),
                it->second.c_str()));
      }
      configFilemap.erase(it);
    }

    const bool useGpu = selected.type == BackendType::GPU;

    if (useGpu) {
      params.mmproj_backend = selected.name;
#ifdef __ANDROID__
      // QVAC-21867: auto-default the projector backend by GPU class.
      // Only Adreno 800+ is benchmarked (QVAC-21257) to encode the projector
      // faster on the mobile GPU than on CPU, so it is the only Android class
      // that defaults to GPU. Every other Android GPU class defaults to CPU
      // (the LLM layers still run on the GPU):
      //   - Mali: the projector encode is slower on the Mali GPU than on CPU
      //     (QVAC-21257 benchmarks).
      //   - Adreno < 800: materially weaker tiers the QVAC-21257
      //     projector-on-GPU benchmarks did not cover (conservative).
      //   - Any GPU whose Adreno tier can't be detected: conservative default.
      // Relax per class once those tiers are benchmarked. The mmproj-use-gpu
      // key overrides this either way.
      constexpr int kAdrenoMmprojGpuThreshold = 800;
      const bool isAdreno800Plus =
          mmprojAdrenoVersion.has_value() &&
          mmprojAdrenoVersion.value() >= kAdrenoMmprojGpuThreshold;
      bool mmprojUseGpu = isAdreno800Plus;
      const char* mmprojDefaultReason =
          isAdreno800Plus ? "auto-default, Adreno 800+"
                          : (selected.isMaliGpu
                                 ? "auto-default, Mali GPU"
                                 : (mmprojAdrenoVersion.has_value()
                                        ? "auto-default, Adreno <800"
                                        : "auto-default, non-Adreno-800+ GPU"));
#else
      bool mmprojUseGpu = true;
      const char* mmprojDefaultReason = "auto-default";
#endif
      if (mmprojUseGpuOverride.has_value()) {
        mmprojUseGpu = mmprojUseGpuOverride.value();
      }
      QLOG_IF(
          Priority::INFO,
          string_format(
              "[LlamaModel] multimodal projector backend: %s (%s)\n",
              mmprojUseGpu ? "GPU" : "CPU",
              mmprojUseGpuOverride.has_value() ? "mmproj-use-gpu override"
                                               : mmprojDefaultReason));
      params.mmproj_use_gpu = mmprojUseGpu;

      params.split_mode = splitMode;
      result.runtimeBackendDevice = 1;

      if (splitMode != LLAMA_SPLIT_MODE_NONE && mainGpu.has_value()) {
        QLOG_IF(
            Priority::WARNING,
            "[LlamaModel] main-gpu is ignored in multi-GPU split-mode\n");
      }
    } else if (selected.type == BackendType::CPU) {
      // Automatic selection only ever looks at *local* hardware (the RPC
      // filter in emplaceIfValidDevice keeps it that way deliberately — see
      // that function), so this branch cannot tell "genuinely no GPU
      // anywhere" apart from "no local GPU, but the caller named remote ones
      // explicitly". Silently forcing single-device CPU inference in the
      // second case would run the whole model locally while reporting
      // success — exactly the failure mode this feature exists to avoid.
      // Require 'devices' in that case instead of guessing.
      if (rpcDevicesRegistered && explicitDevices.empty()) {
        throw qvac_errors::StatusError(
            qvac_errors::general_error::InvalidArgument,
            string_format(
                "%s: 'rpc-servers' was given but no local GPU was found, so "
                "automatic device selection cannot tell which devices to use. "
                "Set 'devices' to name them explicitly (e.g. 'RPC0,RPC1').\n",
                K_LEGACY_PARSER_NAME.data()));
      }
      if (rpcDevicesRegistered) {
        // Caller named devices explicitly (checked above): honor the
        // caller's split-mode and tensor-split as configured, rather than
        // taking the no-GPU-found degrade path below meant for a machine
        // that only ever had CPU as an option.
        params.mmproj_use_gpu = mmprojUseGpuOverride.value_or(true);
        result.runtimeBackendDevice = 1;
        params.split_mode = splitMode;
      } else {
        params.mmproj_use_gpu = false;
        if (mmprojUseGpuOverride.value_or(false)) {
          QLOG_IF(
              Priority::WARNING,
              "[LlamaModel] mmproj-use-gpu ignored: no GPU backend available, "
              "running the multimodal projector on CPU\n");
        }
        result.runtimeBackendDevice = 0;
        params.split_mode = LLAMA_SPLIT_MODE_NONE;
        params.main_gpu = -1;
        if (splitMode != LLAMA_SPLIT_MODE_NONE) {
          QLOG_IF(
              Priority::WARNING,
              "[LlamaModel] split-mode, tensor-split and main-gpu ignored: "
              "no GPU backend available, falling back to CPU\n");
          splitMode = LLAMA_SPLIT_MODE_NONE;
          configFilemap.erase("tensor-split");
          configFilemap.erase("tensor_split");
        }
      }
    } else {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InternalError,
          "preferredDeviceFromString: wrong deduced device, must be 'gpu' or "
          "'cpu'.\n");
    }

    if (splitMode != LLAMA_SPLIT_MODE_NONE) {
      if (explicitDevices.empty()) {
        remapTensorSplit(configFilemap, splitSelection);
      } else {
        remapTensorSplit(
            configFilemap, splitSelection, split(explicitDevices, ',').size());
      }
    }

    if (!explicitDevices.empty()) {
      configVector.emplace_back("--device");
      configVector.emplace_back(explicitDevices);
    } else if (splitMode == LLAMA_SPLIT_MODE_NONE) {
      // In multi-GPU split mode we intentionally omit --device so llama.cpp
      // distributes layers/rows across all available GPUs rather than pinning
      // to the single backend that chooseBackend selected.
      configVector.emplace_back("--device");
      configVector.emplace_back(selected.name);
    } else {
      std::string deviceList;
      params.devices.clear();
      params.devices.reserve(splitSelection.devices.size() + 1);
      for (const backend_selection::SplitDevice& device :
           splitSelection.devices) {
        if (!deviceList.empty()) {
          deviceList += ",";
        }
        deviceList += device.name;
        params.devices.push_back(device.handle);
      }
      params.devices.push_back(nullptr);
      QLOG_IF(
          Priority::INFO,
          string_format(
              "[LlamaModel] split mode: pinning to %zu eligible device(s): "
              "%s\n",
              splitSelection.devices.size(),
              deviceList.c_str()));
    }
    configFilemap.erase("device");

    isGpu = useGpu;
    isOpenCl = isGpu && selected.isOpenCl;
    isMetal = isGpu && selected.isMetal;
  }

  tuneLoadConfigMap(
      configFilemap,
      metadata,
      result.adrenoVersion,
      finetuneOverrides,
      isOpenCl,
      isMetal,
      isGpu,
      // params.split_mode is already assigned above (and reset to NONE on CPU
      // fallback), so this is the mode fabric will actually see. Tensor mode
      // changes how 'auto' is classified for the q8_0 KV default — see the
      // comment on flashAttnEnabled.
      params.split_mode == LLAMA_SPLIT_MODE_TENSOR);

  // QVAC-24253: constraints qvac-fabric places on LLAMA_SPLIT_MODE_TENSOR.
  // Keyed on params.split_mode, not the local splitMode, because that is the
  // value actually handed to fabric: the GPU branch assigns it above and the
  // CPU-fallback branch resets it to NONE, so a tensor request that fell back
  // to CPU correctly skips every check here.
  //
  // Placed AFTER tuneLoadConfigMap on purpose: that call is what applies the
  // flash-attn defaults — on by default, and forced off when finetuning — so
  // this is the first point at which the effective value can be read. Moving
  // this block up into the GPU branch would see only a caller-supplied value
  // and miss both. (tuneLoadConfigMap also forces it off for BitNet, but that
  // path is unreachable here: "bitnet" is on the unsupported-architecture list
  // checked immediately below, so it throws before flash-attn is consulted.)
  if (params.split_mode == LLAMA_SPLIT_MODE_TENSOR) {
    if (!archSupportsTensorSplit(metadata)) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          string_format(
              "%s: split-mode 'tensor' is not supported for architecture '%s' "
              "by this qvac-fabric version; use split-mode 'layer'.\n",
              K_LEGACY_PARSER_NAME.data(),
              metadata.tryGetString("general.architecture")
                  .value_or("unknown")
                  .c_str()));
    }

    // qvac-fabric returns a null context (src/llama-context.cpp, "SPLIT_MODE_
    // TENSOR requires flash_attn to be enabled") rather than a diagnosable
    // error, so reject here instead of silently flipping a value the caller
    // set. AUTO is fine — fabric promotes it to ENABLED itself.
    //
    // Both key spellings must be checked, for the same reason
    // resolveFlashAttn does: when the caller passes flash_attn directly, none
    // of tuneLoadConfigMap's default branches fire, so the value is never
    // normalised into the hyphen key and stays under the underscore one until
    // the configVector loop rewrites it. Reading only "flash-attn" here would
    // let flash_attn=off through.
    //
    // The value spelling matters as much as the key spelling: fabric routes
    // --flash-attn through common_arg_utils::is_falsey, which accepts "off",
    // "disabled", "false" and "0" as equivalent, so comparing against "off"
    // alone would let the other three reach fabric in the state this guard
    // exists to prevent. is_falsey is called directly rather than mirrored, so
    // this guard and the two in tuneLoadConfigMap cannot drift apart. No case
    // folding, matching fabric — resolveFlashAttn has already rejected any
    // value outside the three sets, mixed case included.
    //
    // A contradictory { "flash-attn": …, "flash_attn": … } pair is likewise
    // already rejected by resolveFlashAttn, so at most one key is present by
    // the time this loop runs; it iterates both only to find whichever that is
    // and to name it accurately in the error.
    for (const char* flashAttnKey : {"flash-attn", "flash_attn"}) {
      const auto flashAttnIt = configFilemap.find(flashAttnKey);
      if (flashAttnIt == configFilemap.end()) {
        continue;
      }
      if (common_arg_utils::is_falsey(flashAttnIt->second)) {
        // Under finetuning tuneLoadConfigMap is what wrote flash-attn=off, so
        // telling the caller to remove a key they never set would misdirect
        // them.
        throw qvac_errors::StatusError(
            qvac_errors::general_error::InvalidArgument,
            finetuneOverrides.active
                ? string_format(
                      "%s: split-mode 'tensor' requires flash attention, which "
                      "is disabled while finetuning; use split-mode 'layer' "
                      "for finetuning runs.\n",
                      K_LEGACY_PARSER_NAME.data())
                : string_format(
                      "%s: split-mode 'tensor' requires flash attention; "
                      "remove %s=%s or use split-mode 'layer'.\n",
                      K_LEGACY_PARSER_NAME.data(),
                      flashAttnIt->first.c_str(),
                      flashAttnIt->second.c_str()));
      }
    }

    // Auto-fit is disabled for tensor mode, but the assignment itself lives
    // after the generic arg loop below — see the second tensor block.
  }

  // Handle both reverse-prompt variants
  for (const std::string& key : {"reverse-prompt", "reverse_prompt"}) {
    if (auto iter = configFilemap.find(key); iter != configFilemap.end()) {
      auto listString = iter->second;
      std::vector<std::string> list = split(listString, ',');
      for (const auto& item : list) {
        params.antiprompt.push_back(item);
      }
      if (list.empty() && !listString.empty()) {
        params.antiprompt.push_back(listString);
      }
      configFilemap.erase(iter);
    }
  }

  // transform json config into the format required by llama.cpp
  for (auto& keyValuePair : configFilemap) {
    configVector.push_back(std::string("--") + keyValuePair.first);
    if (!keyValuePair.second.empty()) {
      configVector.push_back(keyValuePair.second);
    }
  }

  auto ctxArg = common_params_parser_init(
      params, LLAMA_EXAMPLE_COMMON, [](int, char**) {});

  // disable warmup run
  params.warmup = false;
  params.training = finetuneOverrides.active;
  // add model path to  model parameters
  params.model.path = modelPath;

  int size = static_cast<int>(configVector.size());

  std::unordered_map<std::string, std::pair<common_arg*, bool>> argToOptions;
  for (auto& opt : ctxArg.options) {
    for (const auto& arg : opt.args) {
      argToOptions[arg] = {&opt, /* isPositive */ true};
    }
    for (const auto& arg : opt.args_neg) {
      argToOptions[arg] = {&opt, /* isPositive */ false};
    }
  }

  // handle config arguments
  auto checkArg = [&](int argIndex) {
    if (argIndex >= size) {
      throw qvac_errors::StatusError(
          ADDON_ID,
          qvac_errors::general_error::toString(
              qvac_errors::general_error::InvalidArgument),
          "Expected value for argument");
    }
  };

  // configFilemap is unordered, so two spellings of one boolean option would
  // otherwise apply in an arbitrary order and the last one would win.
  std::unordered_map<const common_arg*, bool> appliedBooleans;

  for (int argIndex = 0; argIndex < size; argIndex++) {
    const std::string argPrefix = "--";

    std::string arg = configVector.at(argIndex);
    if (arg.starts_with(argPrefix)) {
      std::ranges::replace(arg, '_', '-');
    }
    if (argToOptions.find(arg) == argToOptions.end()) {
      std::string errorMsg = string_format(
          "%s: invalid argument: %s\n",
          K_LEGACY_PARSER_NAME.data(),
          arg.c_str());
      throw qvac_errors::StatusError(
          ADDON_ID,
          qvac_errors::general_error::toString(
              qvac_errors::general_error::InvalidArgument),
          errorMsg);
    }
    auto& entry = argToOptions[arg];
    auto opt = *entry.first;
    const bool isPositive = entry.second;
    if (opt.has_value_from_env()) {
      QLOG_IF(
          Priority::DEBUG,
          string_format(
              "%s: %s variable is set, but will be overwritten by argument "
              "%s\n",
              K_LEGACY_PARSER_NAME.data(),
              opt.env,
              arg.c_str()));
    }
    try {
      if (opt.handler_void != nullptr) {
        opt.handler_void(params);
        continue;
      }

      if (opt.handler_bool != nullptr) {
        bool requested = true;
        if (argIndex + 1 < size &&
            !configVector[argIndex + 1].starts_with(argPrefix)) {
          const std::string& boolVal = configVector[++argIndex];
          if (common_arg_utils::is_truthy(boolVal)) {
            requested = true;
          } else if (common_arg_utils::is_falsey(boolVal)) {
            requested = false;
          } else {
            throw qvac_errors::StatusError(
                ADDON_ID,
                qvac_errors::general_error::toString(
                    qvac_errors::general_error::InvalidArgument),
                string_format(
                    "%s: unknown value for %s: '%s'. Accepted (lower-case): "
                    "on, enabled, true, 1, off, disabled, false, 0.\n",
                    K_LEGACY_PARSER_NAME.data(),
                    arg.c_str(),
                    boolVal.c_str()));
          }
        }
        const bool effective = isPositive == requested;
        const auto [applied, first] =
            appliedBooleans.emplace(entry.first, effective);
        if (!first) {
          if (applied->second != effective) {
            throw qvac_errors::StatusError(
                ADDON_ID,
                qvac_errors::general_error::toString(
                    qvac_errors::general_error::InvalidArgument),
                string_format(
                    "%s: '%s' was given contradictory values; supply one "
                    "spelling.\n",
                    K_LEGACY_PARSER_NAME.data(),
                    opt.args.back()));
          }
          continue;
        }
        opt.handler_bool(params, effective);
        continue;
      }

      // arg with single value
      checkArg(argIndex);
      const std::string& val = configVector[++argIndex];
      if (opt.handler_int != nullptr) {
        opt.handler_int(params, std::stoi(val));
        continue;
      }
      if (opt.handler_string != nullptr) {
        opt.handler_string(params, val);
        continue;
      }

      // arg with 2 values
      checkArg(argIndex);
      const std::string& val2 = configVector[++argIndex];
      if (opt.handler_str_str != nullptr) {
        opt.handler_str_str(params, val, val2);
        continue;
      }
    } catch (std::exception& e) {
      std::string errorMsg = string_format(
          "%s: error while handling argument \"%s\": %s\n\n",
          K_LEGACY_PARSER_NAME.data(),
          arg.c_str(),
          e.what());
      throw qvac_errors::StatusError(
          ADDON_ID,
          qvac_errors::general_error::toString(
              qvac_errors::general_error::InvalidArgument),
          errorMsg);
    }
  }

  // QVAC-24253: auto-fit is disabled for tensor mode HERE, after the generic
  // arg loop, not in the constraint block above. qvac-fabric registers
  // `--fit [on|off]` as a common arg with no example restriction, so it is
  // reachable through this addon's passthrough: a caller passing
  // { "split-mode": "tensor", "fit": "on" } would otherwise have the loop set
  // fit_params back to true after the block cleared it, making the notice
  // below a lie and leaving the caller with fabric's own spurious "failed to
  // fit params to free device memory" WARN — the exact output this is meant
  // to prevent. Assigning after the loop makes the override authoritative.
  //
  // WARNING rather than INFO deliberately: every sibling "we overrode your
  // setting" notice in this function is WARNING, and the library's default
  // verbosity suppresses INFO entirely, so at INFO the one message carrying a
  // real OOM consequence would be invisible by default.
  if (params.split_mode == LLAMA_SPLIT_MODE_TENSOR) {
    params.fit_params = false;
    QLOG_IF(
        Priority::WARNING,
        "[LlamaModel] split-mode 'tensor': auto-fit is not available in this "
        "mode and has been disabled; gpu_layers defaults to every layer and "
        "ctx_size to the model's trained context unless set explicitly\n");
  }

  postprocess_cpu_params(params.cpuparams, nullptr);
  postprocess_cpu_params(params.cpuparams_batch, &params.cpuparams);

  if (!params.kv_overrides.empty()) {
    params.kv_overrides.emplace_back();
    params.kv_overrides.back().key[0] = 0;
  }

  if (!params.tensor_buft_overrides.empty()) {
    params.tensor_buft_overrides.push_back({nullptr, nullptr});
  }

  if (!params.chat_template.empty() &&
      !common_chat_verify_template(params.chat_template, params.use_jinja)) {
    std::string errorMsg = string_format(
        "%s: the supplied chat template is not supported: %s%s\n",
        K_LEGACY_PARSER_NAME.data(),
        params.chat_template.c_str(),
        params.use_jinja ? ""
                         : "\nnote: llama.cpp was started without --jinja, "
                           "we only support commonly used templates");
    throw qvac_errors::StatusError(
        ADDON_ID,
        qvac_errors::general_error::toString(
            qvac_errors::general_error::InvalidArgument),
        errorMsg);
  }

  constexpr int kMinNCtx = 8;
  if (params.n_ctx != 0 && params.n_ctx < kMinNCtx) {
    QLOG_IF(
        Priority::WARNING,
        string_format(
            "%s: warning: minimum context size is 8, using minimum size.\n",
            K_LEGACY_PARSER_NAME.data()));
    params.n_ctx = kMinNCtx;
  }
  if (params.rope_freq_base != 0.0) {
    QLOG_IF(
        Priority::WARNING,
        string_format(
            "%s: changing RoPE frequency base to %g.\n",
            K_LEGACY_PARSER_NAME.data(),
            params.rope_freq_base));
  }
  if (params.rope_freq_scale != 0.0) {
    QLOG_IF(
        Priority::WARNING,
        string_format(
            "%s: scaling RoPE frequency by %g.\n",
            K_LEGACY_PARSER_NAME.data(),
            params.rope_freq_scale));
  }

  result.fitSnapshot =
      makeNormalizedFitSnapshot(result.params, trainedContext(metadata));
  return result;
}

} // namespace load_fit_normalization
