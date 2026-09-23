#include <bare.h>

#include <cctype>
#include <memory>
#include <optional>
#include <span>
#include <string>
#include <utility>
#include <vector>

#include <inference-addon-cpp/Errors.hpp>
#include <inference-addon-cpp/JsInterface.hpp>
#include <inference-addon-cpp/JsUtils.hpp>
#include <inference-addon-cpp/addon/AddonJs.hpp>
#include <inference-addon-cpp/handlers/JsOutputHandlerImplementations.hpp>
#include <inference-addon-cpp/queue/OutputCallbackJs.hpp>
#include <inference-addon-cpp/queue/OutputQueue.hpp>

#include "model/SglangModel.hpp"

namespace qvac_llm_sglang::bindings {
namespace {

namespace addon_cpp = qvac_lib_inference_addon_cpp;
namespace jsu = qvac_lib_inference_addon_cpp::js;

using qvac_errors::StatusError;
using qvac_errors::general_error::InvalidArgument;

std::string lower(std::string value) {
  for (char& c : value) {
    c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  }
  return value;
}

std::string extensionOf(const std::string& path) {
  const auto dot = path.rfind('.');
  if (dot == std::string::npos) {
    return {};
  }
  return lower(path.substr(dot + 1));
}

MediaKind mediaKind(
    const std::string& type, const std::string& mediaType,
    const std::string& path) {
  const std::string hint = lower(type + " " + mediaType);
  if (hint.find("audio") != std::string::npos) {
    return MediaKind::Audio;
  }
  if (hint.find("video") != std::string::npos) {
    return MediaKind::Video;
  }
  if (type == "media" || type == "image" ||
      hint.find("image") != std::string::npos) {
    const std::string ext = extensionOf(path);
    if (ext == "wav" || ext == "mp3" || ext == "flac" || ext == "ogg" ||
        ext == "m4a") {
      return MediaKind::Audio;
    }
    if (ext == "mp4" || ext == "webm" || ext == "mov" || ext == "mkv") {
      return MediaKind::Video;
    }
    return MediaKind::Image;
  }
  return MediaKind::None;
}

std::optional<double> readNumber(
    js_env_t* env, jsu::Object& object, const char* name) {
  return object.getOptionalPropertyAs<jsu::Number, double>(env, name);
}

std::optional<int> readInt(
    js_env_t* env, jsu::Object& object, const char* primary,
    const char* alias) {
  auto value = readNumber(env, object, primary);
  if (!value.has_value() && alias != nullptr) {
    value = readNumber(env, object, alias);
  }
  if (!value.has_value()) {
    return std::nullopt;
  }
  return static_cast<int>(*value);
}

void readSampling(js_env_t* env, jsu::Object& input, SamplingParams& sampling) {
  auto params = input.getOptionalProperty<jsu::Object>(env, "generationParams");
  if (!params.has_value()) {
    return;
  }
  sampling.temperature = readNumber(env, *params, "temperature");
  if (!sampling.temperature) {
    sampling.temperature = readNumber(env, *params, "temp");
  }
  sampling.topP = readNumber(env, *params, "top_p");
  sampling.topK = readInt(env, *params, "top_k", nullptr);
  sampling.maxTokens = readInt(env, *params, "max_tokens", "predict");
  sampling.seed = readInt(env, *params, "seed", nullptr);
  sampling.frequencyPenalty = readNumber(env, *params, "frequency_penalty");
  sampling.presencePenalty = readNumber(env, *params, "presence_penalty");
  sampling.repetitionPenalty = readNumber(env, *params, "repetition_penalty");
  if (!sampling.repetitionPenalty) {
    sampling.repetitionPenalty = readNumber(env, *params, "repeat_penalty");
  }
  sampling.jsonSchema =
      params->getOptionalPropertyAs<jsu::String, std::string>(env, "json_schema");
  sampling.grammar =
      params->getOptionalPropertyAs<jsu::String, std::string>(env, "grammar");
}

ContentPart readPart(js_env_t* env, jsu::Object& message) {
  ContentPart part;
  const std::string type =
      message.getOptionalPropertyAs<jsu::String, std::string>(env, "type")
          .value_or("");
  const std::string mediaType =
      message.getOptionalPropertyAs<jsu::String, std::string>(env, "mediaType")
          .value_or(
              message
                  .getOptionalPropertyAs<jsu::String, std::string>(env, "mime")
                  .value_or(""));
  js_value_t* content = message.getProperty(env, "content");
  if (jsu::is<jsu::String>(env, content)) {
    const std::string text = jsu::String(env, content).as<std::string>(env);
    part.media = mediaKind(type, mediaType, text);
    if (part.media == MediaKind::None) {
      part.text = text;
    } else {
      part.path = text;
    }
    return part;
  }
  if (jsu::is<jsu::TypedArray<std::uint8_t>>(env, content)) {
    auto bytes = jsu::TypedArray<std::uint8_t>(env, content)
                     .as<std::span<const std::uint8_t>>(env);
    part.bytes.assign(bytes.begin(), bytes.end());
    part.media = mediaKind(type, mediaType, "");
    if (part.media == MediaKind::None) {
      throw StatusError(
          InvalidArgument, "binary content requires an image, audio, or video type");
    }
    return part;
  }
  throw StatusError(
      InvalidArgument, "message content must be a string or Uint8Array");
}

Prompt readPrompt(js_env_t* env, jsu::Object& input) {
  Prompt prompt;
  auto messages = input.getProperty<jsu::Array>(env, "messages");
  const uint32_t count = messages.size(env);
  if (count == 0) {
    throw StatusError(InvalidArgument, "messages must not be empty");
  }
  prompt.messages.reserve(count);
  for (uint32_t i = 0; i < count; ++i) {
    auto message = messages.get<jsu::Object>(env, i);
    ChatTurn turn;
    turn.role = message.getPropertyAs<jsu::String, std::string>(env, "role");
    turn.parts.push_back(readPart(env, message));
    prompt.messages.push_back(std::move(turn));
  }
  readSampling(env, input, prompt.sampling);
  return prompt;
}

} // namespace

js_value_t* createInstance(js_env_t* env, js_callback_info_t* info) try {
  addon_cpp::JsArgsParser args(env, info);
  auto config = args.getJsObject(1, "config");
  const std::string baseUrl =
      config.getPropertyAs<jsu::String, std::string>(env, "baseUrl");
  if (baseUrl.empty()) {
    throw StatusError(InvalidArgument, "config.baseUrl is required");
  }

  addon_cpp::out_handl::OutputHandlers<
      addon_cpp::out_handl::JsOutputHandlerInterface>
      outHandlers;
  outHandlers.add(
      std::make_shared<addon_cpp::out_handl::JsStringOutputHandler>());
  auto callback = std::make_unique<addon_cpp::OutputCallBackJs>(
      env, args.get(0, "jsHandle"), args.getFunction(2, "outputCallback"),
      std::move(outHandlers));
  auto model = std::make_unique<SglangModel>(baseUrl);
  auto addon = std::make_unique<addon_cpp::AddonJs>(
      env, std::move(callback),
      std::unique_ptr<addon_cpp::model::IModel>(std::move(model)));
  return addon_cpp::JsInterface::createInstance(env, std::move(addon));
}
JSCATCH

js_value_t* runJob(js_env_t* env, js_callback_info_t* info) try {
  addon_cpp::JsArgsParser args(env, info);
  addon_cpp::AddonJs& instance =
      addon_cpp::JsInterface::getInstance(env, args.get(0, "instance"));
  auto input = args.getJsObject(1, "input");
  Prompt prompt = readPrompt(env, input);
  auto queue = instance.addonCpp->outputQueue;
  prompt.outputCallback = [queue](const std::string& token) {
    if (!token.empty()) {
      queue->queueResult(std::any(token));
    }
  };
  return instance.runJob(std::any(std::move(prompt)));
}
JSCATCH

} // namespace qvac_llm_sglang::bindings

js_value_t* llmSglangExports(js_env_t* env, js_value_t* exports) {
#define V(name, fn)                                                            \
  {                                                                            \
    js_value_t* val;                                                           \
    if (js_create_function(env, name, -1, fn, nullptr, &val) != 0) {           \
      return nullptr;                                                          \
    }                                                                          \
    if (js_set_named_property(env, exports, name, val) != 0) {                 \
      return nullptr;                                                          \
    }                                                                          \
  }

  V("createInstance", qvac_llm_sglang::bindings::createInstance)
  V("runJob", qvac_llm_sglang::bindings::runJob)
  V("loadWeights", qvac_lib_inference_addon_cpp::JsInterface::loadWeights)
  V("activate", qvac_lib_inference_addon_cpp::JsInterface::activate)
  V("cancel", qvac_lib_inference_addon_cpp::JsInterface::cancel)
  V("destroyInstance",
    qvac_lib_inference_addon_cpp::JsInterface::destroyInstance)
  V("setLogger", qvac_lib_inference_addon_cpp::JsInterface::setLogger)
  V("releaseLogger", qvac_lib_inference_addon_cpp::JsInterface::releaseLogger)
#undef V
  return exports;
}

BARE_MODULE(llm_sglang, llmSglangExports)
