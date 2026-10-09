#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <limits>
#include <optional>
#include <sstream>
#include <vector>

#include <ggml-backend.h>
#include <ggml-cpp.h>
#include <inference-addon-cpp/JsInterface.hpp>
#include <inference-addon-cpp/JsUtils.hpp>
#include <inference-addon-cpp/ModelInterfaces.hpp>
#include <inference-addon-cpp/addon/AddonJs.hpp>
#include <inference-addon-cpp/handlers/JsOutputHandlerImplementations.hpp>
#include <inference-addon-cpp/handlers/OutputHandler.hpp>
#include <inference-addon-cpp/queue/OutputCallbackJs.hpp>

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

/** Metadata-only load estimate. No model instance or weight buffer is made. */
inline js_value_t* assessFit(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;
  JsArgsParser args(env, info);
  auto request = args.getJsObject(0, "request");
  auto files = request.getProperty<js::Object>(env, "files");
  auto config = request.getProperty<js::Object>(env, "config");
  const std::string path =
      files.getProperty<js::String>(env, "model").as<std::string>(env);
  const std::string modelType =
      config.getProperty<js::String>(env, "modelType").as<std::string>(env);

  auto optionString = [&](const char* key) -> std::string {
    auto value = config.getOptionalProperty<js::String>(env, key);
    return value ? value->as<std::string>(env) : std::string{};
  };
  auto optionBoolean = [&](const char* key) -> std::optional<bool> {
    auto value = config.getOptionalProperty<js::Boolean>(env, key);
    return value ? std::optional<bool>(value->as<bool>(env)) : std::nullopt;
  };
  auto optionNumber = [&](const char* key) -> std::optional<double> {
    auto value = config.getOptionalProperty<js::Number>(env, key);
    return value ? std::optional<double>(value->as<double>(env)) : std::nullopt;
  };

  double margin = 0;
  if (auto value =
          request.getOptionalProperty<js::Number>(env, "marginBytes")) {
    margin = value->as<double>(env);
    if (!std::isfinite(margin) || margin < 0 || std::trunc(margin) != margin ||
        margin > 9007199254740991.0) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          "marginBytes must be a non-negative safe integer");
    }
  }

  std::string status = "error";
  std::string reason = "model-unreadable";
  std::string backend;
  std::string report;
  uint64_t modelBytes = 0;
  uint64_t requiredBytes = 0;
  uint64_t freeBytes = 0;
  namespace fs = std::filesystem;
  // NOLINTNEXTLINE(clang-diagnostic-deprecated-declarations)
  const fs::path modelPath = fs::u8path(path);
  std::error_code ec;
  if (fs::is_regular_file(modelPath, ec)) {
    modelBytes = fs::file_size(modelPath, ec);
  }
  if (ec || modelBytes < 64 || modelBytes > 9007199254740991ULL) {
    report = "Translation model file is missing, incomplete, or unreadable";
  } else if (modelType == "IndicTrans") {
    std::ifstream stream(modelPath, std::ios::binary);
    uint32_t magic = 0;
    stream.read(reinterpret_cast<char*>(&magic), sizeof(magic));
    if (!stream || magic != GGML_FILE_MAGIC) {
      report = "Translation model header is invalid";
    }
  } else if (modelType != "Bergamot") {
    reason = "unsupported-config";
    report = "Unknown translation model type";
  }

  if (report.empty()) {
    auto pivotValue = files.getOptionalProperty<js::String>(env, "pivotModel");
    const std::string pivot =
        pivotValue ? pivotValue->as<std::string>(env) : "";
    if (!pivot.empty()) {
      // NOLINTNEXTLINE(clang-diagnostic-deprecated-declarations)
      const fs::path pivotPath = fs::u8path(pivot);
      if (modelType != "Bergamot" || !fs::is_regular_file(pivotPath, ec)) {
        reason = "unsupported-config";
        report = "Pivot fit requires two readable Bergamot model files";
      } else {
        const uint64_t pivotBytes = fs::file_size(pivotPath, ec);
        if (ec || pivotBytes > 9007199254740991ULL - modelBytes) {
          report = "Pivot model file is unreadable";
        } else {
          modelBytes += pivotBytes;
        }
      }
    }
  }

  if (report.empty() && modelType == "Bergamot" &&
      path.find(".intgemm") == std::string::npos) {
    reason = "model-unreadable";
    report = "Bergamot model path has no .intgemm signature";
  }
  if (report.empty() && modelType == "Bergamot") {
    auto addVocab = [&](const char* key) {
      if (!report.empty()) {
        return;
      }
      auto value = files.getOptionalProperty<js::String>(env, key);
      const std::string vocab = value ? value->as<std::string>(env) : "";
      // NOLINTNEXTLINE(clang-diagnostic-deprecated-declarations)
      const fs::path vocabPath = fs::u8path(vocab);
      if (vocab.empty() || !fs::is_regular_file(vocabPath, ec)) {
        report = std::string("Bergamot vocabulary is missing: ") + key;
        return;
      }
      const uint64_t bytes = fs::file_size(vocabPath, ec);
      if (ec || bytes > 9007199254740991ULL - modelBytes) {
        report = std::string("Bergamot vocabulary is unreadable: ") + key;
        return;
      }
      modelBytes += bytes;
    };
    addVocab("srcVocab");
    addVocab("dstVocab");
    if (files.getOptionalProperty<js::String>(env, "pivotModel")) {
      addVocab("pivotSrcVocab");
      addVocab("pivotDstVocab");
    }
  }

  if (report.empty()) {
    // CPU is the only backend for Bergamot, regardless of GPU settings.
    const bool useGpu = modelType == "IndicTrans" &&
                        optionBoolean("use_gpu").value_or(
                            optionBoolean("useGPU").value_or(false));
    const std::string backendsDir = optionString("backendsDir");
    const std::string openclCacheDir = optionString("openclCacheDir");
    NmtBackendsHandle backends(backendsDir, openclCacheDir);
    ggml_backend_dev_t device = nullptr;
    if (useGpu) {
      auto canonicalBackend =
          config.getOptionalProperty<js::String>(env, "gpu_backend");
      const std::string gpuBackend =
          canonicalBackend ? canonicalBackend->as<std::string>(env)
                           : optionString("gpuBackend");
      const auto ordinal = optionNumber("gpu_device")
                               .value_or(optionNumber("gpuDevice").value_or(0));
      if (!std::isfinite(ordinal) || std::trunc(ordinal) != ordinal ||
          ordinal < 0 || ordinal > std::numeric_limits<int>::max()) {
        reason = "unsupported-config";
        report = "Invalid GPU device ordinal";
      } else if (
          config.getOptionalProperty<js::Number>(env, "main-gpu") ||
          config.getOptionalProperty<js::Number>(env, "main_gpu") ||
          config.getOptionalProperty<js::String>(env, "main-gpu") ||
          config.getOptionalProperty<js::String>(env, "main_gpu")) {
        reason = "unsupported-config";
        report = "Fit with main-gpu selection is unavailable";
      } else {
        device = nmtSelectGpuDevice(
            true,
            gpuBackend,
            static_cast<int>(ordinal),
            "assessFit",
            {},
            !gpuBackend.empty() || optionNumber("gpu_device").has_value() ||
                optionNumber("gpuDevice").has_value());
      }
    } else {
      device = ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU);
    }
    if (report.empty() && device == nullptr) {
      reason = "device-unavailable";
      report = "Requested compute device is unavailable";
    }
    if (report.empty()) {
      backend = ggml_backend_dev_name(device);
      size_t free = 0;
      size_t total = 0;
      ggml_backend_dev_memory(device, &free, &total);
      freeBytes = free;
      if (freeBytes == 0 || freeBytes > 9007199254740991ULL) {
        reason = "device-memory-unavailable";
        report = "Compute device did not report usable free memory";
      } else {
        // A weight-load allowance. Graph and tokenizer usage is
        // model-dependent; a negative verdict is only issued when even the
        // source bytes exceed free memory.
        constexpr uint64_t overhead = 512ULL * 1024ULL * 1024ULL;
        if (modelBytes <= (9007199254740991ULL - overhead) / 4) {
          requiredBytes = modelBytes * 4 + overhead;
          const uint64_t budget =
              static_cast<uint64_t>(margin) < freeBytes
                  ? freeBytes - static_cast<uint64_t>(margin)
                  : 0;
          size_t hostFree = free;
          if (useGpu) {
            auto* cpu = ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU);
            size_t hostTotal = 0;
            hostFree = 0;
            if (cpu != nullptr) {
              ggml_backend_dev_memory(cpu, &hostFree, &hostTotal);
            }
          }
          if (useGpu && hostFree == 0) {
            reason = "host-memory-unavailable";
          } else if (
              requiredBytes <= budget &&
              static_cast<uint64_t>(margin) < hostFree &&
              requiredBytes <= hostFree - static_cast<uint64_t>(margin)) {
            status = "fits";
            reason = "fits";
          } else if (modelBytes > budget && !useGpu) {
            status = "does-not-fit";
            reason = "does-not-fit";
          } else {
            reason = "insufficient-evidence";
          }
          std::ostringstream stream;
          stream << "Translation load estimate: source=" << modelBytes
                 << " bytes, estimated allowance=" << requiredBytes
                 << " bytes, device free=" << freeBytes
                 << " bytes, host free=" << hostFree
                 << " bytes, margin=" << static_cast<uint64_t>(margin)
                 << " bytes; runtime graph use varies by model";
          report = stream.str();
        } else {
          reason = "footprint-overflow";
          report = "Model is too large to estimate safely";
        }
      }
    }
  }

  auto result = js::Object::create(env);
  result.setProperty(env, "status", js::String::create(env, status));
  result.setProperty(env, "reason", js::String::create(env, reason));
  result.setProperty(env, "backend", js::String::create(env, backend));
  result.setProperty(env, "report", js::String::create(env, report));
  result.setProperty(
      env,
      "modelBytes",
      js::Number::create(env, static_cast<double>(modelBytes)));
  result.setProperty(
      env,
      "requiredBytes",
      js::Number::create(env, static_cast<double>(requiredBytes)));
  result.setProperty(
      env,
      "freeBytes",
      js::Number::create(env, static_cast<double>(freeBytes)));
  return result;
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
