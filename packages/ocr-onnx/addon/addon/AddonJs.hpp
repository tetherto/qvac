#pragma once
#include <array>
#include <memory>
#include <span>

#include <qvac-lib-inference-addon-cpp/Errors.hpp>
#include <qvac-lib-inference-addon-cpp/JsInterface.hpp>
#include <qvac-lib-inference-addon-cpp/JsUtils.hpp>
#include <qvac-lib-inference-addon-cpp/ModelInterfaces.hpp>
#include <qvac-lib-inference-addon-cpp/addon/AddonJs.hpp>
#include <qvac-lib-inference-addon-cpp/handlers/JsOutputHandlerImplementations.hpp>
#include <qvac-lib-inference-addon-cpp/handlers/OutputHandler.hpp>
#include <qvac-lib-inference-addon-cpp/queue/OutputCallbackJs.hpp>

#include "pipeline/Pipeline.hpp"
#include "pipeline/Steps.hpp"

namespace qvac_lib_inference_addon_onnx_ocr_fasttext {

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

js_value_t*
getJsArrayFromOutput(js_env_t* env, const Pipeline::Output& inferredTextList) {
  size_t inferredTextListLength = inferredTextList.size();
  auto jsInferredTextListElements = std::make_unique<js_value_t*[]>(
      inferredTextListLength); /* NOLINT(modernize-avoid-c-arrays,cppcoreguidelines-avoid-c-arrays,hicpp-avoid-c-arrays)
                                */

  // Populate each element of jsInferredTextListElements with an inferredText
  // array: [bounding box, text, confidence]
  for (size_t i = 0; i < inferredTextListLength; i++) {

    // Create bounding box elements: [ [x1, y1], [x2, y2], [x3, y3], [x4, y4 ]
    constexpr size_t boxCoordinatesLength = 4;
    std::array<js_value_t*, boxCoordinatesLength> jsBoxCoordinatesElements{};
    for (size_t boxCoordinateIndex = 0;
         boxCoordinateIndex < boxCoordinatesLength;
         boxCoordinateIndex++) {
      constexpr size_t coordinatePairLength = 2;
      std::array<js_value_t*, coordinatePairLength> jsCoordinatePairElement{};
      jsCoordinatePairElement.at(0) =
          qvac_lib_inference_addon_cpp::js::Number::create(
              env, inferredTextList[i].boxCoordinates.at(boxCoordinateIndex).x);
      jsCoordinatePairElement.at(1) =
          qvac_lib_inference_addon_cpp::js::Number::create(
              env, inferredTextList[i].boxCoordinates.at(boxCoordinateIndex).y);
      jsBoxCoordinatesElements.at(boxCoordinateIndex) =
          createArrayFromElements(env, std::span{jsCoordinatePairElement});
    }

    constexpr size_t inferredTextLength = 3;
    std::array<js_value_t*, inferredTextLength> jsInferredTextElements{};
    jsInferredTextElements.at(0) =
        createArrayFromElements(env, std::span{jsBoxCoordinatesElements});
    jsInferredTextElements.at(1) =
        qvac_lib_inference_addon_cpp::js::String::create(
            env, inferredTextList[i].text);
    jsInferredTextElements.at(2) =
        qvac_lib_inference_addon_cpp::js::Number::create(
            env, inferredTextList[i].confidenceScore);

    jsInferredTextListElements[i] =
        createArrayFromElements(env, std::span{jsInferredTextElements});
  }

  return createArrayFromElements(
      env,
      std::span<js_value_t*>{
          jsInferredTextListElements.get(), inferredTextListLength});
}
} // namespace

// Custom output handler for Pipeline::Output
class PipelineOutputHandler
    : public qvac_lib_inference_addon_cpp::out_handl::JsOutputHandlerInterface {
public:
  void setEnv(js_env_t* env) override { env_ = env; }

  js_value_t* handleOutput(const std::any& output) const override {
    if (output.type() != typeid(Pipeline::Output)) {
      throw std::runtime_error("PipelineOutputHandler: unexpected data type");
    }
    const auto& pipelineOutput = std::any_cast<const Pipeline::Output&>(output);
    return getJsArrayFromOutput(env_, pipelineOutput);
  }

  bool canHandle(const std::any& input) const override {
    return input.type() == typeid(Pipeline::Output);
  }

private:
  js_env_t* env_ = nullptr;
};

namespace {
auto getPath(js_env_t* env, qvac_lib_inference_addon_cpp::js::String path) {
  if constexpr (std::is_same_v<ORTCHAR_T, char>) {
    return path.as<std::string>(env);
  } else if constexpr (
      std::is_same_v<ORTCHAR_T, wchar_t> && sizeof(wchar_t) == 2) {
    size_t length = 0;
    JS(js_get_value_string_utf16le(env, path, nullptr, 0, &length));
    std::wstring str(length, '\0');
    JS(js_get_value_string_utf16le(
        env,
        path,
        reinterpret_cast<uint16_t*>(
            str.data()) /* NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)
                         */
        ,
        length,
        nullptr));
    return str;
  }
}
} // namespace

inline js_value_t* createInstance(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;
  using namespace std;

  auto args = js::getArguments(env, info);
  if (args.size() != 4) {
    throw StatusError{
        general_error::InvalidArgument,
        "Incorrect number of parameters. Expected 4 parameters"};
  }
  if (!js::is<js::Object>(env, args[1])) {
    throw StatusError{
        general_error::InvalidArgument,
        "Expected configurationParams as object"};
  }
  if (!js::is<js::Function>(env, args[2])) {
    throw StatusError{
        general_error::InvalidArgument, "Expected output callback as function"};
  }
  auto args1 = js::Object::fromValue(args[1]);
  auto pathDetector =
      getPath(env, args1.getProperty<js::String>(env, "pathDetector"));
  auto pathRecognizer =
      getPath(env, args1.getProperty<js::String>(env, "pathRecognizer"));
  auto langList = js::toVector<js::String, std::string>(
      env, args1.getProperty<js::Array>(env, "langList"));
  auto optUseGPU = args1.getOptionalProperty<js::Boolean>(env, "useGPU");
  bool useGPU = optUseGPU ? optUseGPU->as<bool>(env) : false;
  auto optTimeout = args1.getOptionalProperty<js::Number>(env, "timeout");
  int timeout = optTimeout ? static_cast<int>(optTimeout->as<double>(env))
                           : DEFAULT_PIPELINE_TIMEOUT_SECONDS;

  // Parse optional config parameters
  Pipeline::Config config;

  auto optMagRatio = args1.getOptionalProperty<js::Number>(env, "magRatio");
  if (optMagRatio) {
    config.magRatio = static_cast<float>(optMagRatio->as<double>(env));
  }

  auto optDefaultRotationAngles =
      args1.getOptionalProperty<js::Array>(env, "defaultRotationAngles");
  if (optDefaultRotationAngles) {
    config.defaultRotationAngles =
        js::toVector<js::Number, int32_t>(env, *optDefaultRotationAngles);
  }

  auto optContrastRetry =
      args1.getOptionalProperty<js::Boolean>(env, "contrastRetry");
  if (optContrastRetry) {
    config.contrastRetry = optContrastRetry->as<bool>(env);
  }

  auto optLowConfidenceThreshold =
      args1.getOptionalProperty<js::Number>(env, "lowConfidenceThreshold");
  if (optLowConfidenceThreshold) {
    config.lowConfidenceThreshold =
        static_cast<float>(optLowConfidenceThreshold->as<double>(env));
  }

  auto optRecognizerBatchSize =
      args1.getOptionalProperty<js::Number>(env, "recognizerBatchSize");
  if (optRecognizerBatchSize) {
    config.recognizerBatchSize =
        static_cast<int>(optRecognizerBatchSize->as<double>(env));
  }

  auto optPipelineMode =
      args1.getOptionalProperty<js::String>(env, "pipelineMode");
  if (optPipelineMode) {
    auto modeStr = optPipelineMode->as<std::string>(env);
    if (modeStr == "doctr") {
      config.mode = PipelineMode::DOCTR;
    } else {
      config.mode = PipelineMode::EASYOCR;
    }
  }

  auto optDecoding =
      args1.getOptionalProperty<js::String>(env, "decodingMethod");
  if (optDecoding) {
    auto str = optDecoding->as<std::string>(env);
    if (str == "attention") {
      config.decodingMethod = DecodingMethod::ATTENTION;
    } else {
      config.decodingMethod = DecodingMethod::CTC;
    }
  }

  auto optStraighten =
      args1.getOptionalProperty<js::Boolean>(env, "straightenPages");
  if (optStraighten) {
    config.straightenPages = optStraighten->as<bool>(env);
  }

  auto model = make_unique<Pipeline>(
      pathDetector.c_str(),
      pathRecognizer.c_str(),
      std::span<const std::string>(langList),
      useGPU,
      timeout,
      config);

  out_handl::OutputHandlers<out_handl::JsOutputHandlerInterface> outHandlers;
  outHandlers.add(make_shared<PipelineOutputHandler>());
  unique_ptr<OutputCallBackInterface> callback = make_unique<OutputCallBackJs>(
      env, args[0], args[2], std::move(outHandlers));

  auto addon = make_unique<AddonJs>(env, std::move(callback), std::move(model));

  return JsInterface::createInstance(env, std::move(addon));
}
JSCATCH

inline js_value_t* runJob(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;
  using namespace std;

  auto args = js::getArguments(env, info);
  if (args.size() != 2) {
    throw StatusError{general_error::InvalidArgument, "Expected 2 parameters"};
  }
  if (!js::is<js::Object>(env, args[1])) {
    throw StatusError{general_error::InvalidArgument, "Expected Object"};
  }
  auto args1 = js::Object::fromValue(args[1]);
  auto type = args1.getProperty<js::String>(env, "type").as<std::string>(env);

  if (type == "image") {
    Pipeline::Input modelInput;

    auto input = args1.getProperty<js::Object>(env, "input");

    // Check if this is an encoded image (JPEG/PNG) that needs decoding
    auto isEncoded = input.getOptionalProperty<js::Boolean>(env, "isEncoded");
    if (isEncoded && isEncoded->as<bool>(env)) {
      modelInput.isEncoded = true;
      modelInput.data = input.getProperty<js::TypedArray<uint8_t>>(env, "data")
                            .as<std::vector<uint8_t>>(env);
    } else {
      modelInput.isEncoded = false;
      modelInput.imageWidth =
          input.getProperty<js::Int32>(env, "width").as<int>(env);
      modelInput.imageHeight =
          input.getProperty<js::Int32>(env, "height").as<int>(env);
      modelInput.data = input.getProperty<js::TypedArray<uint8_t>>(env, "data")
                            .as<std::vector<uint8_t>>(env);
    }

    auto options = args1.getOptionalProperty<js::Object>(env, "options");
    if (options) {
      auto paragraph =
          options->getOptionalProperty<js::Boolean>(env, "paragraph");
      if (paragraph) {
        modelInput.paragraph = paragraph->as<bool>(env);
      }

      auto boxMarginMultiplier =
          options->getOptionalProperty<js::Number>(env, "boxMarginMultiplier");
      if (boxMarginMultiplier) {
        modelInput.boxMarginMultiplier =
            static_cast<float>(boxMarginMultiplier->as<double>(env));
      }

      auto rotationAngles =
          options->getOptionalProperty<js::Array>(env, "rotationAngles");
      if (rotationAngles) {
        modelInput.rotationAngles =
            js::toVector<js::Number, int32_t>(env, *rotationAngles);
      }
    }

    JsInterface::getInstance(env, args[0]).addonCpp->runJob(std::any(std::move(modelInput)));
    return nullptr;
  }
  throw StatusError{general_error::InvalidArgument, "Invalid type"};
}
JSCATCH

} // namespace qvac_lib_inference_addon_onnx_ocr_fasttext
