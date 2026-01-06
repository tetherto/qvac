#include "qvac-lib-infer-whispercpp.hpp"

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <iostream>
#include <memory>
#include <span>
#include <vector>

#include "JSAdapter.hpp"
#include "addon/Addon.hpp"
#include "js.h"
#include "model-interface/whisper.cpp/WhisperConfig.hpp"
#include "model-interface/whisper.cpp/WhisperModel.hpp"
#include "qvac-lib-inference-addon-cpp/Errors.hpp"
#include "qvac-lib-inference-addon-cpp/JsInterface.hpp"
#include "qvac-lib-inference-addon-cpp/JsUtils.hpp"
#include "qvac-lib-inference-addon-cpp/Logger.hpp"

namespace js = qvac_lib_inference_addon_cpp::js;
using JsIfWhisper = qvac_lib_inference_addon_cpp::JsInterface<
    qvac_lib_inference_addon_whisper::Addon>;

using JsLogger = qvac_lib_inference_addon_cpp::logger::JsLogger;
using JSAdapter = qvac_lib_inference_addon_whisper::JSAdapter;

// Log callback that does nothing - disables all whisper.cpp logs
void cb_log_disable(
    enum ggml_log_level /*level*/, const char* /*text*/, void* /*user_data*/) {
} // NOLINT(readability-identifier-naming)

// Store audio format per instance without a global variable
namespace {
inline auto audioFormatMap() -> std::unordered_map<uintptr_t, std::string>& {
  static std::unordered_map<uintptr_t, std::string> map;
  return map;
}
} // namespace

// Helper function to create WhisperConfig from JS parameters using JSAdapter
auto createWhisperConfig(js_env_t* env, const js::Object& configurationParams)
    -> qvac_lib_inference_addon_whisper::WhisperConfig {

  JSAdapter adapter;
  return adapter.loadFromJSObject(configurationParams, env);
}

// Redefinition of functions in the interface for specific behavior of Whisper
namespace qvac_lib_inference_addon_cpp {

// NOLINTNEXTLINE(modernize-use-trailing-return-type)
template <>
auto JsIfWhisper::createInstance(js_env_t* env, js_callback_info_t* info)
    -> js_value_t* // NOLINT(modernize-use-trailing-return-type)
    try {
  whisper_log_set(cb_log_disable, nullptr);

  auto args = js::getArguments(env, info);
  if (args.size() != 4) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument, "Expected 4 parameters");
  }
  if (!js::is<js::Function>(env, args[2])) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "Expected output callback as function");
  }

  /*
  Parse top level config parameters, everything not to do with whisper but the
  addon itself.
  */
  auto configurationParams = js::Object{env, args[1]};

  // Get enableStats from the top level config
  bool enableStats = false;
  auto enableStatsJS =
      configurationParams.getOptionalProperty<js::Boolean>(env, "enableStats");
  if (enableStatsJS.has_value()) {
    enableStats = enableStatsJS.value().as<bool>(env);
  }

  std::string audioFormat = "s16le"; // default
  auto audioFormatJS =
      configurationParams.getOptionalProperty<js::String>(env, "audio_format");
  if (audioFormatJS.has_value()) {
    audioFormat = audioFormatJS.value().as<std::string>(env);
  }

  /*
  Handle whisper config parameters only.

  Nothing from top level is handled here.
  For specifics see

  WhisperHandlers.cpp

  */

  qvac_lib_inference_addon_whisper::WhisperConfig whisperConfig;
  whisperConfig = createWhisperConfig(env, configurationParams);

  std::scoped_lock lockGuard{instancesMtx_};
  const auto& whisperConfigRef = whisperConfig;
  auto& handle = instances_.emplace_back(
      std::make_unique<qvac_lib_inference_addon_whisper::Addon>(
          env, args[0], args[2], args[3], whisperConfigRef, enableStats));

  audioFormatMap()[reinterpret_cast<uintptr_t>(handle.get())] = audioFormat;

  return js::External::create(env, handle.get());
}
JSCATCH

template <>
auto JsIfWhisper::reload(js_env_t* env, js_callback_info_t* info)
    -> js_value_t* try {
  whisper_log_set(cb_log_disable, nullptr);

  auto args = js::getArguments(env, info);

  if (args.size() != 2) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument, "Expected 2 parameters");
  }

  auto configurationParams = js::Object{env, args[1]};

  qvac_lib_inference_addon_whisper::WhisperConfig whisperConfig;
  whisperConfig = createWhisperConfig(env, configurationParams);

  // pass in new whisperConfig and callback function as parameters to the object
  // pointer.
  auto& instance = getInstance(env, args[0]);

  instance.reload(whisperConfig);
  // if you were idle youre going to be idle again,
  // if you were stopped youre going to be stopped again,
  // if you were anything else during the call this function, you would error
  // out.
  return nullptr;
}
JSCATCH

// NOLINTNEXTLINE(modernize-use-trailing-return-type)
template <>
auto JsIfWhisper::append(js_env_t* env, js_callback_info_t* info)
    -> js_value_t* // NOLINT(modernize-use-trailing-return-type,readability-function-cognitive-complexity)
    try {
  using Model = qvac_lib_inference_addon_whisper::WhisperModel;

  auto args = js::getArguments(env, info);
  if (args.size() != 2) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument, "Expected 2 parameters");
  }
  js::Object inputObj = js::Object{env, args[1]};
  auto typeStr =
      inputObj.getProperty<js::String>(env, "type").as<std::string>(env);

  auto& instance = getInstance(env, args[0]);
  if (typeStr == "end of job") {

    return js::Number::create(env, instance.endOfJob());
  }
  if (typeStr == "audio") {
    int priority = getAppendPriority(env, inputObj);
    auto audioBytes =
        inputObj.getProperty<js::TypedArray<uint8_t>>(env, "input")
            .as<std::span<const uint8_t>>(env);
    if (audioBytes.empty()) {
      // Allow empty buffer as a no-op to open/continue a job without data
      Model::Input inp{}; // empty input chunk
      return js::Number::create(env, instance.append(priority, inp));
    }

    // Get the stored audio format from the static map
    std::string audioFormat = "s16le"; // default
    auto found = audioFormatMap().find(reinterpret_cast<uintptr_t>(&instance));
    if (found != audioFormatMap().end()) {
      audioFormat = found->second;
    }

    // Convert raw audio bytes to float samples for whisper.cpp
    std::vector<uint8_t> audioData(audioBytes.begin(), audioBytes.end());

    // Bridge-level validation to surface clear errors
    if (!(audioFormat == "s16le" || audioFormat == "f32le" ||
          audioFormat == "decoded")) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          std::string("Unsupported audio_format: ") + audioFormat);
    }
    if (audioFormat == "s16le") {
      if ((audioData.size() % 2) != 0) {
        throw qvac_errors::StatusError(
            qvac_errors::general_error::InvalidArgument,
            "s16le buffer length must be a multiple of 2");
      }
    } else { // f32le or decoded
      if ((audioData.size() % 4) != 0) {
        throw qvac_errors::StatusError(
            qvac_errors::general_error::InvalidArgument,
            "f32le buffer length must be a multiple of 4");
      }
      if (audioData.size() >= 4) {
        constexpr uint32_t SHIFT_8 = 8;
        constexpr uint32_t SHIFT_16 = 16;
        constexpr uint32_t SHIFT_24 = 24;
        uint32_t bits = (uint32_t)audioData[0] |
                        ((uint32_t)audioData[1] << SHIFT_8) |
                        ((uint32_t)audioData[2] << SHIFT_16) |
                        ((uint32_t)audioData[3] << SHIFT_24);
        float sample = 0.0F;
        std::memcpy(&sample, &bits, sizeof(sample));
        if (!std::isfinite(sample)) {
          throw qvac_errors::StatusError(
              qvac_errors::general_error::InvalidArgument,
              "Encountered non-finite f32 sample");
        }
      }
    }

    Model::Input inp =
        qvac_lib_inference_addon_whisper::WhisperModel::preprocessAudioData(
            audioData, audioFormat);

    return js::Number::create(env, instance.append(priority, inp));
  }
  throw qvac_errors::StatusError(
      qvac_errors::general_error::InvalidArgument, "Invalid type");
}
JSCATCH

} // namespace qvac_lib_inference_addon_cpp

// Exposure of Js Interface functions for Whisper
namespace qvac_lib_inference_addon_whisper {

auto createInstance(js_env_t* env, js_callback_info_t* info) -> js_value_t* {
  return JsIfWhisper::createInstance(env, info);
}

auto unload(js_env_t* env, js_callback_info_t* info) -> js_value_t* {
  return JsIfWhisper::unload(env, info);
}

auto load(js_env_t* env, js_callback_info_t* info) -> js_value_t* {
  return JsIfWhisper::load(env, info);
}

auto loadWeights(js_env_t* env, js_callback_info_t* info) -> js_value_t* {
  return JsIfWhisper::loadWeights(env, info);
}

auto unloadWeights(js_env_t* env, js_callback_info_t* info) -> js_value_t* {
  return JsIfWhisper::unloadWeights(env, info);
}

auto activate(js_env_t* env, js_callback_info_t* info) -> js_value_t* {
  return JsIfWhisper::activate(env, info);
}

auto append(js_env_t* env, js_callback_info_t* info) -> js_value_t* {
  return JsIfWhisper::append(env, info);
}

auto status(js_env_t* env, js_callback_info_t* info) -> js_value_t* {
  return JsIfWhisper::status(env, info);
}

auto pause(js_env_t* env, js_callback_info_t* info) -> js_value_t* {
  return JsIfWhisper::pause(env, info);
}

auto stop(js_env_t* env, js_callback_info_t* info) -> js_value_t* {
  return JsIfWhisper::stop(env, info);
}

auto cancel(js_env_t* env, js_callback_info_t* info) -> js_value_t* {
  return JsIfWhisper::cancel(env, info);
}

auto destroyInstance(js_env_t* env, js_callback_info_t* info) -> js_value_t* {
  return JsIfWhisper::destroyInstance(env, info);
}

// Logger wrapper functions
auto setLogger(js_env_t* env, js_callback_info_t* info) -> js_value_t* {
  return JsLogger::setLogger(env, info);
}

auto releaseLogger(js_env_t* env, js_callback_info_t* info) -> js_value_t* {
  return JsLogger::releaseLogger(env, info);
}

auto reload(js_env_t* env, js_callback_info_t* info) -> js_value_t* {
  return JsIfWhisper::reload(env, info);
}

} // namespace qvac_lib_inference_addon_whisper
