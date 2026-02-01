#include "qvac-lib-infer-onnx-vad.hpp"

#include "addon/Addon.hpp"
#include "qvac-lib-inference-addon-cpp/JsInterface.hpp"

using JsIfSilerovad = qvac_lib_inference_addon_cpp::JsInterface<qvac_lib_inference_addon_onnx_silerovad::VadAddon>;

// Specialization of JsInterface methods
namespace qvac_lib_inference_addon_cpp {

template <>
auto JsIfSilerovad::loadWeights(js_env_t *env, js_callback_info_t * /*info*/) -> js_value_t* try { // NOLINT(modernize-use-trailing-return-type)
  throw std::logic_error{"loadWeights not supported"};
} JSCATCH

template <>
auto JsIfSilerovad::createInstance(js_env_t* env, js_callback_info_t* info) -> js_value_t* try { // NOLINT(modernize-use-trailing-return-type)
  auto args = js::getArguments(env, info);

  if (args.size() != 4) {
    throw js::Error(env, "ARGUMEN_ERROR", "Expected 4 arguments to construct object");
  }

  if (!js::is<js::Object>(env, args[1])) {
    throw js::Error(env, "ARGUMEN_ERROR", "Expected a config parameters Object.");
  }

  if (!js::is<js::Function>(env, args[2])) {
    throw js::Error(env, "ARGUMEN_ERROR", "Expected `outputCb` to be a function.");
  }

  auto args1 = js::Object::fromValue(args[1]);
  auto modelPath = args1.getProperty<js::String>(env, "path").as<std::string>(env);

  std::scoped_lock instancesLock(instancesMtx_);

  auto &handle = instances_.emplace_back(
    std::make_unique<qvac_lib_inference_addon_onnx_silerovad::VadAddon>(
      env, args[0], args[2], args[3], std::cref(modelPath)
    ));

  return js::External::create(env, handle.get());
} JSCATCH

/**
* Appends a job (input) to the job queue for processing
*/
template <>
auto JsIfSilerovad::append(js_env_t* env, js_callback_info_t* info) -> js_value_t* try { // NOLINT(modernize-use-trailing-return-type)
  auto args = js::getArguments(env, info);

  if (args.size() != 2) {
    throw js::Error(env, "ARGUMENT_ERROR", "Expected 2 parameters");
  }

  if (!js::is<js::Object>(env, args[1])) {
    throw js::Error(env, "ARGUMENT_ERROR", "Expected object");
  }

  auto args1 = js::Object::fromValue(args[1]);
  auto type = args1.getProperty<js::String>(env, "type").as<std::string>(env);

  auto& instance = getInstance(env, args[0]);

  if (type == "end of job") {
    return js::Number::create(env, instance.endOfJob());
  }
  if (type == "arrayBuffer") {
    auto priority = getAppendPriority(env, args1);

    js_value_t* input = nullptr;
    JS(js_get_named_property(env, args[1], "input", &input));
    {
      bool isArraybuffer = false;

      JS(js_is_arraybuffer(env, input, &isArraybuffer)); // Make sure input is an ArrayBuffer

      if (!isArraybuffer) {
        throw js::Error(env, "ARGUMENT_ERROR", "Expected ArrayBuffer as input.");
      }
    }

    size_t len = 0;
    qvac_lib_inference_addon_onnx_silerovad::VadIterator::ValueType* data = nullptr;

    JS(js_get_arraybuffer_info(env, input, reinterpret_cast<void**>(&data), &len)); // NOLINT(cppcoreguidelines-pro-type-reinterpret-cast)

    std::span<const float> vadInput { static_cast<float*>(data), len / sizeof(float) };

    return js::Number::create(env, instance.append(priority, vadInput));
  }
  throw js::Error{ env, "ARGUMENT_ERROR", "Invalid type" };
} JSCATCH

}

namespace qvac_lib_inference_addon_onnx_silerovad {

auto createInstance(js_env_t *env, js_callback_info_t *info) -> js_value_t* {
  return JsIfSilerovad::createInstance(env, info);
}

auto loadWeights(js_env_t *env, js_callback_info_t *info) -> js_value_t* {
  return JsIfSilerovad::loadWeights(env, info);
}

auto activate(js_env_t *env, js_callback_info_t *info) -> js_value_t* {
  return JsIfSilerovad::activate(env, info);
}

auto append(js_env_t *env, js_callback_info_t *info) -> js_value_t* {
  return JsIfSilerovad::append(env, info);
}

auto status(js_env_t *env, js_callback_info_t *info) -> js_value_t* {
  return JsIfSilerovad::status(env, info);
}

auto pause(js_env_t *env, js_callback_info_t *info) -> js_value_t* {
  return JsIfSilerovad::pause(env, info);
}

auto stop(js_env_t *env, js_callback_info_t *info) -> js_value_t* {
  return JsIfSilerovad::stop(env, info);
}

auto cancel(js_env_t *env, js_callback_info_t *info) -> js_value_t* {
  return JsIfSilerovad::cancel(env, info);
}

auto destroyInstance(js_env_t *env, js_callback_info_t *info) -> js_value_t* {
  return JsIfSilerovad::destroyInstance(env, info);
}

}
