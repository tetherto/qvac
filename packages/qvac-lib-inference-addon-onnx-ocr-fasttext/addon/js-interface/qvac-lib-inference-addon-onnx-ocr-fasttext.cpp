#include "qvac-lib-inference-addon-onnx-ocr-fasttext.hpp"

#include "addon/Addon.hpp"
#include "qvac-lib-inference-addon-cpp/JsInterface.hpp"

using JsIfFasttext = qvac_lib_inference_addon_cpp::JsInterface<qvac_lib_inference_addon_onnx_ocr_fasttext::Addon>;

// Specialization of JsInterface methods for Pipeline addon
namespace qvac_lib_inference_addon_cpp {

namespace {

qvac_lib_inference_addon_onnx_ocr_fasttext::Pipeline::InputView getModelInput(js_env_t *env, js::Object args1) {
  qvac_lib_inference_addon_onnx_ocr_fasttext::Pipeline::InputView modelInput;

  auto input = args1.getProperty<js::Object>(env, "input");

  // Check if this is an encoded image (JPEG/PNG) that needs decoding
  auto isEncoded = input.getOptionalProperty<js::Boolean>(env, "isEncoded");
  if (isEncoded && isEncoded->as<bool>(env)) {
    // Encoded image - only data is required, width/height will be determined after decoding
    modelInput.isEncoded = true;
    modelInput.data = input.getProperty<js::TypedArray<uint8_t>>(env, "data").as<std::vector<uint8_t>>(env);
  } else {
    // Raw image data - requires width, height, and data
    modelInput.isEncoded = false;
    modelInput.imageWidth = input.getProperty<js::Int32>(env, "width").as<int>(env);
    modelInput.imageHeight = input.getProperty<js::Int32>(env, "height").as<int>(env);
    modelInput.data = input.getProperty<js::TypedArray<uint8_t>>(env, "data").as<std::vector<uint8_t>>(env);
  }

  auto options = args1.getOptionalProperty<js::Object>(env, "options");
  if (options) {
    auto paragraph = options->getOptionalProperty<js::Boolean>(env, "paragraph");
    if (paragraph) {
      modelInput.paragraph = paragraph->as<bool>(env);
    }

    auto boxMarginMultiplier = options->getOptionalProperty<js::Number>(env, "boxMarginMultiplier");
    if (boxMarginMultiplier) {
      modelInput.boxMarginMultiplier = static_cast<float>(boxMarginMultiplier->as<double>(env));
    }

    auto rotationAngles = options->getOptionalProperty<js::Array>(env, "rotationAngles");
    if (rotationAngles) {
      modelInput.rotationAngles = js::toVector<js::Number, int32_t>(env, *rotationAngles);
    }
  }

  return modelInput;
}

auto getPath(js_env_t* env, js::String path) {
  if constexpr (std::is_same_v<ORTCHAR_T, char>) {
    return path.as<std::string>(env);
  } else if constexpr (std::is_same_v<ORTCHAR_T, wchar_t> && sizeof(wchar_t) == 2) {
    size_t length = 0;
    JS(js_get_value_string_utf16le(env, path, nullptr, 0, &length));
    std::wstring str(length, '\0');
    JS(js_get_value_string_utf16le(env, path, reinterpret_cast<uint16_t*>(str.data()) /* NOLINT(cppcoreguidelines-pro-type-reinterpret-cast) */, length, nullptr));
    return str;
  }
}

} // namespace

template <> js_value_t *JsIfFasttext::createInstance(js_env_t *env, js_callback_info_t *info) try {
  auto args = js::getArguments(env, info);
  if (args.size() != 4) {
    throw StatusError{
        general_error::InvalidArgument,
        "Incorrect number of parameters. Expected 4  parameters"};
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
  auto pathDetector = getPath(env, args1.getProperty<js::String>(env, "pathDetector"));
  auto pathRecognizer = getPath(env, args1.getProperty<js::String>(env, "pathRecognizer"));
  auto langList = js::toVector<js::String, std::string>(env, args1.getProperty<js::Array>(env, "langList"));
  auto optUseGPU = args1.getOptionalProperty<js::Boolean>(env, "useGPU");
  bool useGPU = optUseGPU ? optUseGPU->as<bool>(env) : true;
  auto optTimeout = args1.getOptionalProperty<js::Number>(env, "timeout");
  int timeout = optTimeout ? optTimeout->as<int>(env) : qvac_lib_inference_addon_onnx_ocr_fasttext::DEFAULT_PIPELINE_TIMEOUT_SECONDS;

  // Parse optional config parameters
  qvac_lib_inference_addon_onnx_ocr_fasttext::PipelineConfig config;

  auto optMagRatio = args1.getOptionalProperty<js::Number>(env, "magRatio");
  if (optMagRatio) {
    config.magRatio = static_cast<float>(optMagRatio->as<double>(env));
  }

  auto optDefaultRotationAngles = args1.getOptionalProperty<js::Array>(env, "defaultRotationAngles");
  if (optDefaultRotationAngles) {
    config.defaultRotationAngles = js::toVector<js::Number, int32_t>(env, *optDefaultRotationAngles);
  }

  auto optContrastRetry = args1.getOptionalProperty<js::Boolean>(env, "contrastRetry");
  if (optContrastRetry) {
    config.contrastRetry = optContrastRetry->as<bool>(env);
  }

  auto optLowConfidenceThreshold = args1.getOptionalProperty<js::Number>(env, "lowConfidenceThreshold");
  if (optLowConfidenceThreshold) {
    config.lowConfidenceThreshold = static_cast<float>(optLowConfidenceThreshold->as<double>(env));
  }

  auto optRecognizerBatchSize = args1.getOptionalProperty<js::Number>(env, "recognizerBatchSize");
  if (optRecognizerBatchSize) {
    config.recognizerBatchSize = static_cast<int>(optRecognizerBatchSize->as<double>(env));
  }

  std::scoped_lock instancesLock{instancesMtx_};
  auto& handle = instances_.emplace_back(
      std::make_unique<qvac_lib_inference_addon_onnx_ocr_fasttext::Addon>(
          env,
          pathDetector.c_str(),
          pathRecognizer.c_str(),
          std::span<const std::string>(langList),
          useGPU,
          timeout,
          config,
          args[0],
          args[2],
          args[3]));
  return js::External::create(env, handle.get());
}
JSCATCH

template <> js_value_t *JsIfFasttext::loadWeights(js_env_t *env, js_callback_info_t *info) try {
   (void)info; throw std::logic_error{"loadWeights not supported"};
}
JSCATCH

template <> js_value_t *JsIfFasttext::append(js_env_t *env, js_callback_info_t *info) try {
  auto args = js::getArguments(env, info);
  if (args.size() != 2) {
    throw StatusError{general_error::InvalidArgument, "Expected 2 parameters"};
  }
  if (!js::is<js::Object>(env, args[1])) {
    throw StatusError{general_error::InvalidArgument, "Expected Object"};
  }
  auto args1 = js::Object::fromValue(args[1]);
  auto type = args1.getProperty<js::String>(env, "type").as<std::string>(env);

  auto &instance = getInstance(env, args[0]);

  if (type == "image") {
    auto priority = getAppendPriority(env, args1);

    qvac_lib_inference_addon_onnx_ocr_fasttext::Pipeline::InputView modelInput = getModelInput(env, args1);

    return js::Number::create(env, instance.append(priority, modelInput));
  }
  throw StatusError{general_error::InvalidArgument, "Invalid type"};
}
JSCATCH

} // namespace qvac_lib_inference_addon_cpp

namespace qvac_lib_inference_addon_onnx_ocr_fasttext {

js_value_t *createInstance(js_env_t *env, js_callback_info_t *info) {
  return JsIfFasttext::createInstance(env, info);
}

js_value_t *loadWeights(js_env_t *env, js_callback_info_t *info) {
  return JsIfFasttext::loadWeights(env, info);
}

js_value_t *activate(js_env_t *env, js_callback_info_t *info) {
  return JsIfFasttext::activate(env, info);
}

js_value_t *append(js_env_t *env, js_callback_info_t *info) {
  return JsIfFasttext::append(env, info);
}

js_value_t *status(js_env_t *env, js_callback_info_t *info) {
  return JsIfFasttext::status(env, info);
}

js_value_t *pause(js_env_t *env, js_callback_info_t *info) {
  return JsIfFasttext::pause(env, info);
}

js_value_t *stop(js_env_t *env, js_callback_info_t *info) {
  return JsIfFasttext::stop(env, info);
}

js_value_t *cancel(js_env_t *env, js_callback_info_t *info) {
  return JsIfFasttext::cancel(env, info);
}

js_value_t *destroyInstance(js_env_t *env, js_callback_info_t *info) {
  return JsIfFasttext::destroyInstance(env, info);
}

js_value_t *setLogger(js_env_t *env, js_callback_info_t *info) {
  return JsIfFasttext::setLogger(env, info);
}

js_value_t *releaseLogger(js_env_t *env, js_callback_info_t *info) {
  return JsIfFasttext::releaseLogger(env, info);
}

} // namespace qvac_lib_inference_addon_onnx_ocr_fasttext
