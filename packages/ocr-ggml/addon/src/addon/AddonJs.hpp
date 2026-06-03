#pragma once

// JS-side glue for the ocr-ggml bare addon:
//
//   - `createInstance(jsHandle, configurationParams, outputCallback)`
//       Parses the `params` object (pathDetector, pathRecognizer, langList,
//       optional config knobs) and constructs a `Pipeline`. The `params
//       .pipelineType` string ('easyocr' | 'doctr') maps to
//       `OcrConfig::mode`, which selects the EasyOCR or DocTR step
//       sequence inside the unified `Pipeline` class. Wires up a
//       `PipelineOutputHandler` so the C++ `std::vector<InferredText>` is
//       converted to a JS array of `[box, text, confidence]` triples
//       (same shape as @qvac/ocr-onnx).
//
//   - `runJob(instance, { type: 'image', input: { ... }, options })`
//       Parses the image payload (encoded JPEG/PNG bytes or raw RGB
//       width/height/data) plus per-call options (paragraph, rotationAngles,
//       boxMarginMultiplier) and submits an `OcrInput` job.

#include <array>
#include <memory>
#include <span>
#include <utility>
#include <vector>

#include <inference-addon-cpp/Errors.hpp>
#include <inference-addon-cpp/JsInterface.hpp>
#include <inference-addon-cpp/JsUtils.hpp>
#include <inference-addon-cpp/ModelInterfaces.hpp>
#include <inference-addon-cpp/addon/AddonJs.hpp>
#include <inference-addon-cpp/handlers/JsOutputHandlerImplementations.hpp>
#include <inference-addon-cpp/handlers/OutputHandler.hpp>
#include <inference-addon-cpp/queue/OutputCallbackJs.hpp>

#include "model-interface/OcrTypes.hpp"
#include "model-interface/Pipeline.hpp"
#include "model-interface/easyocr/pipeline/steps.hpp"

// NOLINTBEGIN(readability-identifier-naming,readability-identifier-length)
// JS-side glue: identifiers follow the @qvac/ocr-onnx JS API surface; layer
// indices and shape constants come straight from the JS payload.

namespace qvac_lib_infer_ocr_ggml {

namespace {

js_value_t*
createArrayFromElements(js_env_t* env, std::span<js_value_t*> elements) {
  js_value_t* jsArray = nullptr;
  js_create_array_with_length(env, elements.size(), &jsArray);
  js_set_array_elements(
      env,
      jsArray,
      const_cast<const js_value_t**>(elements.data()),
      elements.size(),
      0);
  return jsArray;
}

// Mirrors @qvac/ocr-onnx's `getJsArrayFromOutput`. Output schema for each
// inferred text: [ [[x,y]*4], text, confidence ].
js_value_t*
outputToJs(js_env_t* env, const Pipeline::Output& inferredTextList) {
  const size_t n = inferredTextList.size();
  std::vector<js_value_t*> jsInferredTextListElements(n);

  for (size_t i = 0; i < n; ++i) {
    constexpr size_t kBoxLen = 4;
    std::array<js_value_t*, kBoxLen> jsBoxCoordinatesElements{};
    for (size_t boxIdx = 0; boxIdx < kBoxLen; ++boxIdx) {
      constexpr size_t kPairLen = 2;
      std::array<js_value_t*, kPairLen> jsCoordinatePairElement{};
      jsCoordinatePairElement.at(0) =
          qvac_lib_inference_addon_cpp::js::Number::create(
              env, inferredTextList.at(i).boxCoordinates.at(boxIdx).x);
      jsCoordinatePairElement.at(1) =
          qvac_lib_inference_addon_cpp::js::Number::create(
              env, inferredTextList.at(i).boxCoordinates.at(boxIdx).y);
      jsBoxCoordinatesElements.at(boxIdx) =
          createArrayFromElements(env, std::span{jsCoordinatePairElement});
    }

    constexpr size_t kRowLen = 3;
    std::array<js_value_t*, kRowLen> jsRowElements{};
    jsRowElements.at(0) =
        createArrayFromElements(env, std::span{jsBoxCoordinatesElements});
    jsRowElements.at(1) = qvac_lib_inference_addon_cpp::js::String::create(
        env, inferredTextList.at(i).text);
    jsRowElements.at(2) = qvac_lib_inference_addon_cpp::js::Number::create(
        env, inferredTextList.at(i).confidenceScore);

    jsInferredTextListElements.at(i) =
        createArrayFromElements(env, std::span{jsRowElements});
  }

  return createArrayFromElements(
      env, std::span<js_value_t*>{jsInferredTextListElements.data(), n});
}

class OcrOutputHandler
    : public qvac_lib_inference_addon_cpp::out_handl::JsOutputHandlerInterface {
public:
  void setEnv(js_env_t* env) override { env_ = env; }

  [[nodiscard]] js_value_t*
  handleOutput(const std::any& output) const override {
    if (output.type() != typeid(Pipeline::Output)) {
      throw std::runtime_error("OcrOutputHandler: unexpected data type");
    }
    return outputToJs(env_, std::any_cast<const Pipeline::Output&>(output));
  }

  [[nodiscard]] bool canHandle(const std::any& input) const override {
    return input.type() == typeid(Pipeline::Output);
  }

private:
  js_env_t* env_ = nullptr;
};

std::string
getPath(js_env_t* env, qvac_lib_inference_addon_cpp::js::String path) {
  return path.as<std::string>(env);
}

// Optional `params.backendDevice` ('cpu' | 'vulkan'). Default keeps CPU
// inference; 'vulkan' requests a Vulkan-capable GPU with transparent CPU
// fallback (see OcrBackendSelection). Extracted from createInstance to keep
// that factory's cognitive complexity under the clang-tidy threshold.
void applyBackendDevice(
    js_env_t* env, qvac_lib_inference_addon_cpp::js::Object& params,
    OcrConfig& config) {
  using namespace qvac_lib_inference_addon_cpp;
  auto optBackendDevice =
      params.getOptionalProperty<js::String>(env, "backendDevice");
  if (!optBackendDevice) {
    return;
  }
  const auto backendDevice = optBackendDevice->as<std::string>(env);
  if (backendDevice == "vulkan") {
    config.backendDevice = BackendDevice::VULKAN;
  } else if (backendDevice == "cpu") {
    config.backendDevice = BackendDevice::CPU;
  } else {
    throw StatusError{
        general_error::InvalidArgument,
        "backendDevice must be 'cpu' or 'vulkan'"};
  }
}

// Optional `params.pipelineType` ('easyocr' | 'doctr'). Default matches the
// JS / TS / CLI / README contract: EasyOCR is the primary pipeline; callers
// opt in to DocTR explicitly. `config.mode` defaults to PipelineMode::EASYOCR
// in OcrTypes.hpp.
void applyPipelineMode(
    js_env_t* env, qvac_lib_inference_addon_cpp::js::Object& params,
    OcrConfig& config) {
  using namespace qvac_lib_inference_addon_cpp;
  auto optPipeline =
      params.getOptionalProperty<js::String>(env, "pipelineType");
  if (!optPipeline) {
    return;
  }
  const auto pipelineType = optPipeline->as<std::string>(env);
  if (pipelineType == "doctr") {
    config.mode = PipelineMode::DOCTR;
  } else if (pipelineType == "easyocr") {
    config.mode = PipelineMode::EASYOCR;
  } else {
    throw StatusError{
        general_error::InvalidArgument,
        "pipelineType must be 'easyocr' or 'doctr'"};
  }
}

} // namespace

inline js_value_t* createInstance(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  auto args = js::getArguments(env, info);
  if (args.size() != 3) {
    throw StatusError{
        general_error::InvalidArgument,
        "Incorrect number of parameters. Expected 3 parameters"};
  }
  if (!js::is<js::Object>(env, args.at(1))) {
    throw StatusError{
        general_error::InvalidArgument,
        "Expected configurationParams as object"};
  }
  if (!js::is<js::Function>(env, args.at(2))) {
    throw StatusError{
        general_error::InvalidArgument, "Expected output callback as function"};
  }

  auto args1 = js::Object::fromValue(args.at(1));
  auto pathDetector =
      getPath(env, args1.getProperty<js::String>(env, "pathDetector"));
  auto pathRecognizer =
      getPath(env, args1.getProperty<js::String>(env, "pathRecognizer"));
  auto langList = js::toVector<js::String, std::string>(
      env, args1.getProperty<js::Array>(env, "langList"));

  OcrConfig config;

  if (auto optMagRatio = args1.getOptionalProperty<js::Number>(env, "magRatio");
      optMagRatio) {
    config.magRatio = static_cast<float>(optMagRatio->as<double>(env));
  }
  if (auto optCanvasSize =
          args1.getOptionalProperty<js::Number>(env, "canvasSize");
      optCanvasSize) {
    config.canvasSize = static_cast<int>(optCanvasSize->as<double>(env));
  }
  if (auto optAngles =
          args1.getOptionalProperty<js::Array>(env, "defaultRotationAngles");
      optAngles) {
    config.defaultRotationAngles =
        js::toVector<js::Number, int32_t>(env, *optAngles);
  }
  if (auto optContrast =
          args1.getOptionalProperty<js::Boolean>(env, "contrastRetry");
      optContrast) {
    config.contrastRetry = optContrast->as<bool>(env);
  }
  if (auto optLow =
          args1.getOptionalProperty<js::Number>(env, "lowConfidenceThreshold");
      optLow) {
    config.lowConfidenceThreshold = static_cast<float>(optLow->as<double>(env));
  }
  if (auto optBatch =
          args1.getOptionalProperty<js::Number>(env, "recognizerBatchSize");
      optBatch) {
    config.recognizerBatchSize = static_cast<int>(optBatch->as<double>(env));
  }
  if (auto optThreads = args1.getOptionalProperty<js::Number>(env, "nThreads");
      optThreads) {
    config.nThreads = static_cast<int>(optThreads->as<double>(env));
  }
  if (auto optBackendsDir =
          args1.getOptionalProperty<js::String>(env, "backendsDir");
      optBackendsDir) {
    config.backendsDir = optBackendsDir->as<std::string>(env);
  }

  // Optional opt-in backend device and pipeline selection. Both default via
  // OcrConfig (CPU inference, EasyOCR pipeline) when the property is absent;
  // parsing is delegated to helpers to keep this factory's cognitive
  // complexity under the clang-tidy threshold.
  applyBackendDevice(env, args1, config);
  applyPipelineMode(env, args1, config);

  auto model = std::make_unique<Pipeline>(
      pathDetector,
      pathRecognizer,
      std::span<const std::string>(langList),
      config);

  out_handl::OutputHandlers<out_handl::JsOutputHandlerInterface> outHandlers;
  outHandlers.add(std::make_shared<OcrOutputHandler>());

  std::unique_ptr<OutputCallBackInterface> callback =
      std::make_unique<OutputCallBackJs>(
          env, args.at(0), args.at(2), std::move(outHandlers));

  auto addon =
      std::make_unique<AddonJs>(env, std::move(callback), std::move(model));

  return JsInterface::createInstance(env, std::move(addon));
}
JSCATCH

inline js_value_t* runJob(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  auto args = js::getArguments(env, info);
  if (args.size() != 2) {
    throw StatusError{general_error::InvalidArgument, "Expected 2 parameters"};
  }
  if (!js::is<js::Object>(env, args.at(1))) {
    throw StatusError{general_error::InvalidArgument, "Expected Object"};
  }
  auto args1 = js::Object::fromValue(args.at(1));
  auto type = args1.getProperty<js::String>(env, "type").as<std::string>(env);

  if (type != "image") {
    throw StatusError{general_error::InvalidArgument, "Invalid type"};
  }

  OcrInput modelInput;

  auto input = args1.getProperty<js::Object>(env, "input");

  if (auto isEncoded = input.getOptionalProperty<js::Boolean>(env, "isEncoded");
      isEncoded && isEncoded->as<bool>(env)) {
    modelInput.isEncoded = true;
    modelInput.data = input.getProperty<js::TypedArray<uint8_t>>(env, "data")
                          .as<std::vector<uint8_t>>(env);
  } else {
    modelInput.isEncoded = false;
    modelInput.imageWidth =
        input.getProperty<js::Int32>(env, "width").as<int>(env);
    modelInput.imageHeight =
        input.getProperty<js::Int32>(env, "height").as<int>(env);
    if (auto bpp =
            input.getOptionalProperty<js::Number>(env, "bitsPerPixel");
        bpp) {
      modelInput.bitsPerPixel = bpp->as<int>(env);
    }
    modelInput.data = input.getProperty<js::TypedArray<uint8_t>>(env, "data")
                          .as<std::vector<uint8_t>>(env);
  }

  if (auto options = args1.getOptionalProperty<js::Object>(env, "options");
      options) {
    if (auto paragraph =
            options->getOptionalProperty<js::Boolean>(env, "paragraph");
        paragraph) {
      modelInput.paragraph = paragraph->as<bool>(env);
    }
    if (auto boxMargin = options->getOptionalProperty<js::Number>(
            env, "boxMarginMultiplier");
        boxMargin) {
      modelInput.boxMarginMultiplier =
          static_cast<float>(boxMargin->as<double>(env));
    }
    if (auto rotationAngles =
            options->getOptionalProperty<js::Array>(env, "rotationAngles");
        rotationAngles) {
      modelInput.rotationAngles =
          js::toVector<js::Number, int32_t>(env, *rotationAngles);
    }
  }

  JsInterface::getInstance(env, args.at(0))
      .addonCpp->runJob(std::any(std::move(modelInput)));
  return nullptr;
}
JSCATCH

// Returns the backend device the pipeline resolved for inference as a JS
// object: `{ requested, backendDevice, backendName, fallbackReason }`. This is
// the programmatic surface for the selected ggml backend (RuntimeStats can only
// carry numbers, so backend identity strings are exposed here). Consumed by
// `OcrGgml._getDiagnosticsJSON()` and the Vulkan integration test.
inline js_value_t* getBackendInfo(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  auto args = js::getArguments(env, info);
  if (args.size() != 1) {
    throw StatusError{
        general_error::InvalidArgument,
        "Expected 1 parameter (instance handle)"};
  }

  auto& instance = JsInterface::getInstance(env, args.at(0));
  auto* pipeline = dynamic_cast<Pipeline*>(&instance.addonCpp->model.get());
  if (pipeline == nullptr) {
    throw StatusError{
        general_error::InvalidArgument,
        "getBackendInfo: instance is not an ocr-ggml Pipeline"};
  }

  const auto& backendInfo = pipeline->backendInfo();
  auto result = js::Object::create(env);
  result.setProperty(
      env, "requested", js::String::create(env, backendInfo.requested));
  result.setProperty(
      env, "backendDevice", js::String::create(env, backendInfo.backendDevice));
  result.setProperty(
      env, "backendName", js::String::create(env, backendInfo.backendName));
  result.setProperty(
      env,
      "fallbackReason",
      js::String::create(env, backendInfo.fallbackReason));
  return result;
}
JSCATCH

} // namespace qvac_lib_infer_ocr_ggml

// NOLINTEND(readability-identifier-naming,readability-identifier-length)
