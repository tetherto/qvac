#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <limits>
#include <mutex>
#include <optional>
#include <utility>
#include <vector>

#if defined(__APPLE__)
#include <TargetConditionals.h>
#if TARGET_OS_IPHONE && !TARGET_OS_SIMULATOR
#include <os/proc.h>
#endif
#endif

#include <ggml-backend.h>
#include <ggml-cpp.h>
#include <inference-addon-cpp/JsInterface.hpp>
#include <inference-addon-cpp/JsUtils.hpp>
#include <inference-addon-cpp/ModelInterfaces.hpp>
#include <inference-addon-cpp/addon/AddonJs.hpp>
#include <inference-addon-cpp/handlers/JsOutputHandlerImplementations.hpp>
#include <inference-addon-cpp/handlers/OutputHandler.hpp>
#include <inference-addon-cpp/queue/OutputCallbackJs.hpp>

#include "addon/FitVerdict.hpp"
#include "model-interface/PivotTranslationModel.hpp"
#include "model-interface/TranslationModel.hpp"

namespace {
using namespace qvac_lib_inference_addon_cpp;
static std::unordered_map<
    std::string, std::variant<double, int64_t, std::string>>
getConfigMap( // NOLINT(readability-static-definition-in-anonymous-namespace)
    js_env_t* env, js::Object configurationParams, const char* propertyName) {
  auto configOpt =
      configurationParams.getOptionalProperty<js::Object>(env, propertyName);
  std::unordered_map<std::string, std::variant<double, int64_t, std::string>>
      configMap;

  if (!configOpt.has_value()) {
    return configMap;
  }

  auto config = configOpt.value();
  js_value_t* configKeys; // NOLINT(cppcoreguidelines-init-variables)
  JS(js_get_property_names(env, config, &configKeys));

  js::Array configKeysArray(env, configKeys);
  uint32_t configKeysSz = configKeysArray.size(env);

  bool hasPivotModel = false;
  while (configKeysSz > 0) {
    configKeysSz--;
    js_value_t* key; // NOLINT(cppcoreguidelines-init-variables)
    JS(js_get_element(env, configKeys, configKeysSz, &key));
    auto value = // NOLINT(readability-qualified-auto)
        config.getProperty(env, key);

    std::string keyString = // NOLINT(hicpp-use-auto,modernize-use-auto)
        js::String::fromValue(key).as<std::string>(env);

    std::transform( // NOLINT(modernize-use-ranges)
        keyString.begin(),
        keyString.end(),
        keyString.begin(),
        [](unsigned char chr) { return std::tolower(chr); });
    if (keyString == "pivotmodel") {
      hasPivotModel = true; // NOLINT(clang-analyzer-deadcode.DeadStores)
      continue;
    }
    if ((keyString == "main-gpu" || keyString == "main_gpu") &&
        (js::is<js::Boolean>(env, value) || js::is<js::BigInt>(env, value))) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          "main-gpu must be a 32-bit integer registry index, 'dedicated', or "
          "'integrated'");
    }
    if (js::is<js::Boolean>(env, value)) {
      // Map booleans to int64 {0,1} so downstream config readers can treat
      // them uniformly (TranslationModel::setConfig reads "use_gpu" this way).
      auto jsBool = js::Boolean{env, value};
      configMap[keyString] = static_cast<int64_t>(jsBool.as<bool>(env) ? 1 : 0);
    } else if (
        js::is<js::Int32>(env, value) || js::is<js::Uint32>(env, value) ||
        js::is<js::BigInt>(env, value)) {
      auto jsNumber = js::Number{env, value};
      configMap[keyString] = jsNumber.as<int64_t>(env);
    } else if (js::is<js::Number>(env, value)) {
      auto jsNumber = js::Number{env, value};
      configMap[keyString] = jsNumber.as<double>(env);
    } else if (js::is<js::String>(env, value)) {
      auto jsString = js::String::fromValue(value);
      configMap[keyString] = jsString.as<std::string>(env);
    } else {
      std::string msg = "Expected boolean, numeric or string value for config "
                        "key '" +
                        keyString + "' but got a different type";
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument, msg);
    }
  }

  return configMap;
}

} // namespace
namespace qvac_lib_inference_addon_nmt {

/** A fit request copied out of JS, owned by the worker that measures it. */
struct FitRequest {
  std::string modelPath;
  std::string modelType;
  std::optional<std::string> pivotModel;
  std::string srcVocab;
  std::string dstVocab;
  std::string pivotSrcVocab;
  std::string pivotDstVocab;
  double marginBytes = 0;
  bool useGpu = false;
  std::string backendsDir;
  std::string openclCacheDir;
  std::string gpuBackend;
  std::optional<double> gpuDevice;
  bool hasMainGpu = false;
};

struct FitResult {
  // "fits", "does-not-fit", or "unknown" when no reliable verdict exists.
  std::string status = "unknown";
  std::vector<FitDevice> devices;
};

constexpr uint64_t K_MAX_SAFE_INTEGER = 9007199254740991ULL;

[[noreturn]] inline void throwFitError(
    qvac_errors::general_error::GeneralErrorCode code,
    const std::string& message) {
  throw qvac_errors::StatusError(code, "assessFit: " + message);
}

// The PCI bus ID when the backend reports one, so the same GPU matches across
// addons built on different backends; the device name otherwise. Device
// handles are borrowed from the backend, so their strings are copied here.
//
// Unified marks memory the host owns: the CPU, an integrated GPU, a GPU that
// says it shares host memory, Android's OpenCL GPU, and a device that reports
// no memory of its own. A unified device that reports none takes the CPU's
// figures.
inline FitDevice fitDevice(ggml_backend_dev_t device, uint64_t usedBytes) {
  ggml_backend_dev_props props{};
  ggml_backend_dev_get_props(device, &props);
  uint64_t freeBytes = static_cast<uint64_t>(props.memory_free);
  uint64_t totalBytes = static_cast<uint64_t>(props.memory_total);
  const bool reportsNoMemory = totalBytes == 0;
#if defined(__ANDROID__)
  const char* registry =
      ggml_backend_reg_name(ggml_backend_dev_backend_reg(device));
  const bool androidOpenCl =
      registry != nullptr && std::strcmp(registry, "OpenCL") == 0;
#else
  const bool androidOpenCl = false;
#endif
  const bool unified = props.memory_unified ||
                       props.type == GGML_BACKEND_DEVICE_TYPE_IGPU ||
                       props.type == GGML_BACKEND_DEVICE_TYPE_CPU ||
                       androidOpenCl || reportsNoMemory;
  if (unified && reportsNoMemory) {
    if (ggml_backend_dev_t host =
            ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU)) {
      size_t hostFree = 0;
      size_t hostTotal = 0;
      ggml_backend_dev_memory(host, &hostFree, &hostTotal);
      freeBytes = static_cast<uint64_t>(hostFree);
      totalBytes = static_cast<uint64_t>(hostTotal);
    }
  }
  return {
      props.device_id != nullptr ? props.device_id : props.name,
      props.name,
      unified,
      usedBytes,
      freeBytes,
      totalBytes};
}

inline FitRequest parseFitRequest(js_env_t* env, js_callback_info_t* info) {
  using namespace qvac_lib_inference_addon_cpp;
  JsArgsParser args(env, info);
  auto request = args.getJsObject(0, "request");
  auto files = request.getProperty<js::Object>(env, "files");
  auto config = request.getProperty<js::Object>(env, "config");

  auto optionalString = [&](js::Object& source,
                            const char* key) -> std::optional<std::string> {
    auto value = source.getOptionalProperty<js::String>(env, key);
    return value ? std::optional<std::string>(value->as<std::string>(env))
                 : std::nullopt;
  };
  auto optionBoolean = [&](const char* key) -> std::optional<bool> {
    auto value = config.getOptionalProperty<js::Boolean>(env, key);
    return value ? std::optional<bool>(value->as<bool>(env)) : std::nullopt;
  };
  auto optionNumber = [&](const char* key) -> std::optional<double> {
    auto value = config.getOptionalProperty<js::Number>(env, key);
    return value ? std::optional<double>(value->as<double>(env)) : std::nullopt;
  };
  auto optionPresent = [&](const char* key) {
    js_value_t* value = config.getProperty(env, key);
    return !js::is<js::Undefined>(env, value) && !js::is<js::Null>(env, value);
  };

  FitRequest parsed;
  parsed.modelPath =
      files.getProperty<js::String>(env, "model").as<std::string>(env);
  parsed.modelType =
      config.getProperty<js::String>(env, "modelType").as<std::string>(env);

  if (auto value =
          request.getOptionalProperty<js::Number>(env, "marginBytes")) {
    parsed.marginBytes = value->as<double>(env);
    const double margin = parsed.marginBytes;
    if (!std::isfinite(margin) || margin < 0 || std::trunc(margin) != margin ||
        margin > 9007199254740991.0) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          "marginBytes must be a non-negative safe integer");
    }
  }

  parsed.pivotModel = optionalString(files, "pivotModel");
  if (parsed.modelType == "Bergamot") {
    parsed.srcVocab = optionalString(files, "srcVocab").value_or("");
    parsed.dstVocab = optionalString(files, "dstVocab").value_or("");
    if (parsed.pivotModel) {
      parsed.pivotSrcVocab =
          optionalString(files, "pivotSrcVocab").value_or("");
      parsed.pivotDstVocab =
          optionalString(files, "pivotDstVocab").value_or("");
    }
  }

  parsed.backendsDir = optionalString(config, "backendsDir").value_or("");
  parsed.openclCacheDir = optionalString(config, "openclCacheDir").value_or("");

  // CPU is the only backend for Bergamot, regardless of GPU settings.
  if (parsed.modelType == "IndicTrans") {
    parsed.useGpu = optionBoolean("use_gpu").value_or(
        optionBoolean("useGPU").value_or(false));
  }
  if (parsed.useGpu) {
    // A present canonical `gpu_backend`, even empty, wins over its alias.
    auto canonicalBackend = optionalString(config, "gpu_backend");
    parsed.gpuBackend = canonicalBackend
                            ? *canonicalBackend
                            : optionalString(config, "gpuBackend").value_or("");
    auto canonicalDevice = optionNumber("gpu_device");
    parsed.gpuDevice =
        canonicalDevice ? canonicalDevice : optionNumber("gpuDevice");
    parsed.hasMainGpu = optionPresent("main-gpu") || optionPresent("main_gpu");
  }
  return parsed;
}

/**
 * Metadata-only load estimate. No model instance or weight buffer is made, and
 * no JS is touched. Fits are serialised: device memory queries are not
 * documented as thread safe across ggml backends. The backends handle holds a
 * reference for the whole device phase, so a model unloading meanwhile cannot
 * reset the backend state underneath it.
 */
inline FitResult runFit(const FitRequest& request) {
  static std::mutex fitMutex;
  const std::lock_guard<std::mutex> lock(fitMutex);

  using qvac_errors::general_error::InternalError;
  using qvac_errors::general_error::InvalidArgument;
  const std::string& path = request.modelPath;
  const std::string& modelType = request.modelType;
  const auto margin = static_cast<uint64_t>(request.marginBytes);

  namespace fs = std::filesystem;
  // NOLINTNEXTLINE(clang-diagnostic-deprecated-declarations)
  const fs::path modelPath = fs::u8path(path);
  std::error_code ec;
  uint64_t modelBytes = 0;
  if (fs::is_regular_file(modelPath, ec)) {
    modelBytes = fs::file_size(modelPath, ec);
  }
  if (ec || modelBytes < 64 || modelBytes > K_MAX_SAFE_INTEGER) {
    throwFitError(InvalidArgument, "cannot read the translation model " + path);
  }
  if (modelType == "IndicTrans") {
    std::ifstream stream(modelPath, std::ios::binary);
    uint32_t magic = 0;
    stream.read(reinterpret_cast<char*>(&magic), sizeof(magic));
    if (!stream || magic != GGML_FILE_MAGIC) {
      throwFitError(
          InvalidArgument, "the translation model header is invalid: " + path);
    }
  } else if (modelType != "Bergamot") {
    throwFitError(
        InvalidArgument, "unknown translation model type " + modelType);
  }

  const std::string pivot = request.pivotModel.value_or("");
  if (!pivot.empty()) {
    if (modelType != "Bergamot") {
      throwFitError(InvalidArgument, "a pivot model needs a Bergamot model");
    }
    // NOLINTNEXTLINE(clang-diagnostic-deprecated-declarations)
    const fs::path pivotPath = fs::u8path(pivot);
    const uint64_t pivotBytes =
        fs::is_regular_file(pivotPath, ec) ? fs::file_size(pivotPath, ec) : 0;
    if (ec || pivotBytes == 0 || pivotBytes > K_MAX_SAFE_INTEGER - modelBytes) {
      throwFitError(InvalidArgument, "cannot read the pivot model " + pivot);
    }
    modelBytes += pivotBytes;
  }

  if (modelType == "Bergamot") {
    if (path.find(".intgemm") == std::string::npos) {
      throwFitError(
          InvalidArgument,
          "a Bergamot model path carries no .intgemm signature: " + path);
    }
    auto addVocab = [&](const char* key, const std::string& vocab) {
      // NOLINTNEXTLINE(clang-diagnostic-deprecated-declarations)
      const fs::path vocabPath = fs::u8path(vocab);
      if (vocab.empty() || !fs::is_regular_file(vocabPath, ec)) {
        throwFitError(
            InvalidArgument,
            std::string("the Bergamot vocabulary is missing: ") + key);
      }
      const uint64_t bytes = fs::file_size(vocabPath, ec);
      if (ec || bytes > K_MAX_SAFE_INTEGER - modelBytes) {
        throwFitError(
            InvalidArgument,
            std::string("cannot read the Bergamot vocabulary: ") + key);
      }
      modelBytes += bytes;
    };
    addVocab("srcVocab", request.srcVocab);
    addVocab("dstVocab", request.dstVocab);
    if (request.pivotModel) {
      addVocab("pivotSrcVocab", request.pivotSrcVocab);
      addVocab("pivotDstVocab", request.pivotDstVocab);
    }
  }

  FitResult result;
  const bool useGpu = request.useGpu;
  NmtBackendsHandle backends(request.backendsDir, request.openclCacheDir);
  ggml_backend_dev_t device = nullptr;
  if (useGpu) {
    const auto ordinal = request.gpuDevice.value_or(0);
    if (!std::isfinite(ordinal) || std::trunc(ordinal) != ordinal ||
        ordinal < 0 || ordinal > std::numeric_limits<int>::max()) {
      throwFitError(InvalidArgument, "invalid GPU device ordinal");
    }
    // The fitter cannot follow a main-gpu selection.
    if (request.hasMainGpu) {
      return result;
    }
    device = nmtSelectGpuDevice(
        true,
        request.gpuBackend,
        static_cast<int>(ordinal),
        "assessFit",
        {},
        !request.gpuBackend.empty() || request.gpuDevice.has_value());
  } else {
    device = ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU);
  }
  if (device == nullptr) {
    throwFitError(
        useGpu ? InvalidArgument : InternalError,
        "the requested compute device is unavailable");
  }

  // A weight-load allowance. Graph and tokenizer usage is model-dependent; a
  // negative verdict is only issued when even the source bytes exceed free
  // memory, and between the two ends the answer stays unknown.
  constexpr uint64_t overhead = 512ULL * 1024ULL * 1024ULL;
  if (modelBytes > (K_MAX_SAFE_INTEGER - overhead) / 4) {
    throwFitError(InvalidArgument, "the model is too large to estimate safely");
  }
  const uint64_t requiredBytes = modelBytes * 4 + overhead;

  // The allowance is charged to the selected device, then the host CPU row. A
  // discrete GPU's host stages the source bytes while the weights load; on a
  // device that shares host memory the staging is the same memory, so its host
  // row carries nothing more. A load on the CPU is one row. A verdict always
  // carries the host row, so a registry without a CPU device to name it by
  // leaves the load unsized.
  const bool cpu =
      ggml_backend_dev_type(device) == GGML_BACKEND_DEVICE_TYPE_CPU;
  std::vector<FitDevice> rows{fitDevice(device, requiredBytes)};
  if (!cpu) {
    ggml_backend_dev_t host =
        ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU);
    if (host == nullptr) {
      return result;
    }
    rows.push_back(fitDevice(host, rows.front().unified ? 0 : modelBytes));
  }
  for (const FitDevice& row : rows) {
    if (row.freeBytes == 0 || row.freeBytes > K_MAX_SAFE_INTEGER) {
      return result;
    }
  }

#if defined(__APPLE__) && TARGET_OS_IPHONE && !TARGET_OS_SIMULATOR
  capToAppLimit(rows, static_cast<uint64_t>(os_proc_available_memory()));
#endif

  result.status = fitVerdict(rows, modelBytes, margin, cpu);
  if (result.status != "unknown") {
    result.devices = std::move(rows);
  }
  return result;
}

inline js_value_t* fitResultObject(js_env_t* env, const FitResult& fit) {
  using namespace qvac_lib_inference_addon_cpp;
  auto bytes = [env](uint64_t value) {
    return js::Number::create(env, static_cast<double>(value));
  };
  auto result = js::Object::create(env);
  result.setProperty(env, "status", js::String::create(env, fit.status));
  auto devices = js::Array::create(env);
  for (size_t i = 0; i < fit.devices.size(); ++i) {
    const auto& row = fit.devices[i];
    auto entry = js::Object::create(env);
    entry.setProperty(env, "id", js::String::create(env, row.id));
    entry.setProperty(env, "name", js::String::create(env, row.name));
    entry.setProperty(env, "unified", js::Boolean::create(env, row.unified));
    entry.setProperty(env, "usedBytes", bytes(row.usedBytes));
    entry.setProperty(env, "freeBytes", bytes(row.freeBytes));
    entry.setProperty(env, "totalBytes", bytes(row.totalBytes));
    devices.set(env, i, entry);
  }
  result.setProperty(env, "devices", devices);
  result.setProperty(env, "stats", js::Object::create(env));
  return result;
}

/** Resolves the load estimate from a native worker thread. */
inline js_value_t* assessFit(js_env_t* env, js_callback_info_t* info) try {
  FitRequest request = parseFitRequest(env, info);
  return js::JsAsyncTask::run(
      env,
      [request = std::move(request)]() { return runFit(request); },
      fitResultObject);
}
JSCATCH

inline js_value_t* createInstance(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);

  auto configurationParamsJs = args.getJsObject(1, "config");
  auto modelConfig = getConfigMap(env, configurationParamsJs, "config");

  auto modelConfigJs =
      configurationParamsJs.getProperty<js::Object>(env, "config");
  auto pivotModelConfigJs =
      modelConfigJs.getOptionalProperty<js::Object>(env, "pivotModel");

  std::unique_ptr<qvac_lib_inference_addon_cpp::model::IModel> model;

  auto modelPathJs =
      configurationParamsJs.getOptionalProperty<js::String>(env, "path");

  std::string modelPath =
      modelPathJs ? modelPathJs.value().as<std::string>(env) : "";
  // Checking for pivot translation
  if (pivotModelConfigJs.has_value()) {
    auto secondModelPathJs =
        pivotModelConfigJs->getOptionalProperty<js::String>(env, "path");
    std::string secondModelPath =
        secondModelPathJs ? secondModelPathJs.value().as<std::string>(env) : "";

    auto pivotModelConfig =
        getConfigMap(env, pivotModelConfigJs.value(), "config");

    auto pivotTranslationModel = std::make_unique<PivotTranslationModel>(
        modelPath, modelConfig, secondModelPath, pivotModelConfig);
    model = std::move(pivotTranslationModel);
  } else {
    auto translationModel =
        std::make_unique<qvac_lib_inference_addon_nmt::TranslationModel>(
            modelPath);

    translationModel->setConfig(modelConfig);
    translationModel->load();

    model = std::move(translationModel);
  }

  out_handl::OutputHandlers<out_handl::JsOutputHandlerInterface> outHandlers;

  outHandlers.add(make_shared<out_handl::JsStringOutputHandler>());
  outHandlers.add(make_shared<out_handl::JsStringArrayOutputHandler>());

  unique_ptr<OutputCallBackInterface> callback = make_unique<OutputCallBackJs>(
      env,
      args.get(0, "jsHandle"),
      args.getFunction(2, "outputCallback"),
      std::move(outHandlers));

  auto addon =
      std::make_unique<AddonJs>(env, std::move(callback), std::move(model));

  return JsInterface::createInstance(env, std::move(addon));
}
JSCATCH

inline js_value_t*
getActiveBackendName(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);
  AddonJs& instance = JsInterface::getInstance(env, args.get(0, "instance"));

  // The shared AddonCpp stores the model as IModel& — getActiveBackendName()
  // only lives on TranslationModel. A downcast failure means the active model
  // is PivotTranslationModel (Bergamot), which is CPU-only by design.
  auto& model = instance.addonCpp->model.get();
  auto* translationModel =
      dynamic_cast<qvac_lib_inference_addon_nmt::TranslationModel*>(&model);
  if (translationModel != nullptr) {
    return js::String::create(
        env, translationModel->getActiveBackendName().c_str());
  }
  auto* pivotModel =
      dynamic_cast<qvac_lib_inference_addon_nmt::PivotTranslationModel*>(
          &model);
  std::string name = (pivotModel != nullptr && pivotModel->isLoaded())
                         ? std::string("Bergamot-CPU")
                         : std::string("Unloaded");
  return js::String::create(env, name.c_str());
}
JSCATCH

inline js_value_t*
getActiveBackendDescription(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);
  AddonJs& instance = JsInterface::getInstance(env, args.get(0, "instance"));

  auto& model = instance.addonCpp->model.get();
  auto* translationModel =
      dynamic_cast<qvac_lib_inference_addon_nmt::TranslationModel*>(&model);
  if (translationModel != nullptr) {
    return js::String::create(
        env, translationModel->getActiveBackendDescription().c_str());
  }
  return js::String::create(env, "");
}
JSCATCH

inline js_value_t* runJob(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);

  AddonJs& instance = JsInterface::getInstance(env, args.get(0, "instance"));
  auto [type, jsInput] = JsInterface::getInput(args);

  std::any anyInput;
  if (type == "text") {
    anyInput = js::String(env, jsInput).as<std::string>(env);
  } else if (type == "sequences") {
    auto vectorOfJsValues =
        js::Array(env, jsInput).as<std::vector<js_value_t*>>(env);
    std::vector<std::string> inputSequence;
    inputSequence.reserve(vectorOfJsValues.size());

    std::transform( // NOLINT(modernize-use-ranges)
        vectorOfJsValues.begin(),
        vectorOfJsValues.end(),
        std::back_inserter(inputSequence),
        [&env](js_value_t* const stringValue) {
          return js::String(env, stringValue).as<std::string>(env);
        });

    anyInput = inputSequence;
  }

  if (!anyInput.has_value()) {
    throw StatusError(general_error::InvalidArgument, type);
  }

  return instance.runJob(std::move(anyInput));
}
JSCATCH

} // namespace qvac_lib_inference_addon_nmt
