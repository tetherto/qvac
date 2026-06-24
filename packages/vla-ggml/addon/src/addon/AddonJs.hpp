#pragma once

#include <cstdint>
#include <cstring>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include <inference-addon-cpp/JsInterface.hpp>
#include <inference-addon-cpp/JsUtils.hpp>
#include <inference-addon-cpp/Logger.hpp>
#include <inference-addon-cpp/ModelInterfaces.hpp>
#include <inference-addon-cpp/addon/AddonJs.hpp>
#include <inference-addon-cpp/handlers/JsOutputHandlerImplementations.hpp>
#include <inference-addon-cpp/handlers/OutputHandler.hpp>
#include <inference-addon-cpp/queue/OutputCallbackJs.hpp>

#include "../utils/LoggingMacros.hpp"
#include "AddonCpp.hpp"

namespace qvac_lib_infer_vla_ggml {

namespace detail {

// Resolve the AddonJs instance handle (arg 0) to the underlying VlaModel.
// All VLA-specific accessors (hparams, backendName) need this because the
// framework only stores the model behind an IModel reference.
inline VlaModel& vlaFromInstance(js_env_t* env, js_value_t* instanceHandle) {
  using namespace qvac_lib_inference_addon_cpp;
  auto& instance = JsInterface::getInstance(env, instanceHandle);
  auto* vla = dynamic_cast<VlaModel*>(&instance.addonCpp->model.get());
  if (vla == nullptr) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "Instance handle does not refer to a VlaModel");
  }
  return *vla;
}

// Copy a JS Float32Array into a std::vector<float>. The framework runs
// process() on a worker thread after the JS callback returns, so input
// buffers must be owned copies — we cannot keep raw JS-side pointers like
// the old sync runVlaModel did.
inline std::vector<float> copyFloat32(js_env_t* env, js_value_t* jsArr) {
  float* data = nullptr;
  size_t len = 0;
  if (js_get_typedarray_info(
          env,
          jsArr,
          nullptr,
          reinterpret_cast<void**>(&data),
          &len,
          nullptr,
          nullptr) != 0) {
    throw std::runtime_error("expected Float32Array");
  }
  return {data, data + len};
}

inline std::vector<int32_t> copyInt32(js_env_t* env, js_value_t* jsArr) {
  int32_t* data = nullptr;
  size_t len = 0;
  if (js_get_typedarray_info(
          env,
          jsArr,
          nullptr,
          reinterpret_cast<void**>(&data),
          &len,
          nullptr,
          nullptr) != 0) {
    throw std::runtime_error("expected Int32Array");
  }
  return {data, data + len};
}

inline std::vector<uint8_t> copyUint8(js_env_t* env, js_value_t* jsArr) {
  uint8_t* data = nullptr;
  size_t len = 0;
  if (js_get_typedarray_info(
          env,
          jsArr,
          nullptr,
          reinterpret_cast<void**>(&data),
          &len,
          nullptr,
          nullptr) != 0) {
    throw std::runtime_error("expected Uint8Array");
  }
  return {data, data + len};
}

// Parse the run input object emitted by index.js into the std::any payload
// that gets handed to the worker thread. Mirrors the field layout of
// VlaInput exactly.
inline VlaInput parseRunInput(js_env_t* env, js_value_t* inputVal) {
  using namespace qvac_lib_inference_addon_cpp;
  js::Object obj(env, inputVal);

  VlaInput in;

  js::Array imagesArr = obj.getProperty<js::Array>(env, "images");
  const uint32_t nImages = imagesArr.size(env);
  in.images.reserve(nImages);
  for (uint32_t i = 0; i < nImages; i++) {
    js::TypedArray<float> elem = imagesArr.get<js::TypedArray<float>>(env, i);
    in.images.push_back(copyFloat32(env, elem));
  }

  in.imgWidth = obj.getPropertyAs<js::Number, int32_t>(env, "imgWidth");
  in.imgHeight = obj.getPropertyAs<js::Number, int32_t>(env, "imgHeight");

  in.state =
      copyFloat32(env, obj.getProperty<js::TypedArray<float>>(env, "state"));
  in.tokens =
      copyInt32(env, obj.getProperty<js::TypedArray<int32_t>>(env, "tokens"));
  in.mask =
      copyUint8(env, obj.getProperty<js::TypedArray<uint8_t>>(env, "mask"));

  if (auto noiseOpt =
          obj.getOptionalProperty<js::TypedArray<float>>(env, "noise")) {
    in.noise = copyFloat32(env, *noiseOpt);
  }

  return in;
}

} // namespace detail

// createInstance(jsHandle, { ggufPath, backend }, outputCb) -> External
//
// Builds the VlaModel + the framework's output callback stack and registers
// it as a managed instance. `jsHandle` is the JS-side wrapper object that
// the framework passes back as the first argument of every outputCb call.
// `backend === 'cpu'` forces the CPU backend even on a runner with a usable
// GPU; any other value lets the addon pick the best device.
inline js_value_t* createInstance(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);

  const std::string ggufPath = args.getMapEntry(1, "ggufPath");
  const std::string backend = args.getMapEntry(1, "backend");
  const std::string backendsDir = args.getMapEntry(1, "backendsDir");
  const bool forceCpu = (backend == "cpu");

  auto model = std::make_unique<VlaModel>(ggufPath, forceCpu, backendsDir);

  // VLA emits a single Float32Array (the action chunk) per job; runtime
  // stats and errors are added to the handler stack by OutputCallBackJs.
  out_handl::OutputHandlers<out_handl::JsOutputHandlerInterface> outHandlers;
  outHandlers.add(
      std::make_shared<out_handl::JsTypedArrayOutputHandler<float>>());
  std::unique_ptr<OutputCallBackInterface> callback =
      std::make_unique<OutputCallBackJs>(
          env,
          args.get(0, "jsHandle"),
          args.getFunction(2, "outputCallback"),
          std::move(outHandlers));

  auto addon =
      std::make_unique<AddonJs>(env, std::move(callback), std::move(model));
  return JsInterface::createInstance(env, std::move(addon));
}
JSCATCH

// runJob(instance, { type: 'vla', input: { images, imgWidth, imgHeight,
//   state, tokens, mask, noise? } }) -> bool
//
// Returns true if the job was accepted, false if a previous job is still
// in flight. Output (Float32Array actions) and stats arrive asynchronously
// on the outputCb registered at createInstance.
inline js_value_t* runJob(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);
  auto [type, jsInput] = JsInterface::getInput(args);
  if (type != "vla") {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "Unknown input type: " + type);
  }

  std::any input{detail::parseRunInput(env, jsInput)};
  return JsInterface::getInstance(env, args.get(0, "instance"))
      .runJob(std::move(input));
}
JSCATCH

// getVlaBackendName(instance) -> string
//
// Name of the ggml backend the loaded model is running on ("CPU", "Vulkan",
// "OpenCL", "Metal", …). Used by the integration test to tag each perf-
// report row with its execution provider so CPU vs GPU runs are
// distinguishable in the Step Summary tables. RuntimeStats already exposes
// the numeric `backendDevice` (0/1) — this returns the human-readable name.
inline js_value_t*
getVlaBackendName(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);
  VlaModel& model = detail::vlaFromInstance(env, args.get(0, "instance"));
  const std::string name = model.backendName();

  js_value_t* str = nullptr;
  if (js_create_string_utf8(
          env,
          reinterpret_cast<const utf8_t*>(name.c_str()),
          name.size(),
          &str) != 0) {
    throw std::runtime_error("js_create_string_utf8 failed");
  }
  return str;
}
JSCATCH

// getVlaHparams(instance) -> { chunkSize, actionDim, maxActionDim,
//                              maxStateDim, tokenizerMaxLength,
//                              visionImageSize, numCameras, stateInputMode }
//
// `numCameras` and `stateInputMode` let JS-side input validation
// distinguish a SmolVLA model (2 cameras,
// continuous state) from a π₀.₅ model (up to 3 cameras, discrete state
// inlined into the prompt). The existing fields are unchanged.
inline js_value_t* getVlaHparams(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);
  VlaModel& model = detail::vlaFromInstance(env, args.get(0, "instance"));
  const VlaHparamsGeneric& hp = model.hparams();

  js_value_t* obj = nullptr;
  if (js_create_object(env, &obj) != 0) {
    throw std::runtime_error("js_create_object failed");
  }
  auto setInt = [&](const char* name, int32_t value) {
    js_value_t* v = nullptr;
    js_create_int32(env, value, &v);
    js_set_named_property(env, obj, name, v);
  };
  auto setStr = [&](const char* name, const char* value) {
    js_value_t* v = nullptr;
    js_create_string_utf8(
        env, reinterpret_cast<const utf8_t*>(value), std::strlen(value), &v);
    js_set_named_property(env, obj, name, v);
  };
  setInt("chunkSize", hp.chunk_size);
  setInt("actionDim", hp.action_dim);
  setInt("maxActionDim", hp.max_action_dim);
  setInt("maxStateDim", hp.max_state_dim);
  setInt("tokenizerMaxLength", hp.tokenizer_max_length);
  setInt("visionImageSize", hp.vision_image_size);
  setInt("numCameras", hp.num_cameras);
  setStr(
      "stateInputMode",
      hp.state_input_mode == VlaHparamsGeneric::StateInputMode::Discrete
          ? "discrete"
          : "continuous");
  return obj;
}
JSCATCH

// setVerbosity(level: 0..4) -> undefined
//
// 0=ERROR, 1=WARNING, 2=INFO, 3=DEBUG, 4=OFF (matches @qvac/logging priorities
// and qvac_lib_inference_addon_cpp::logger::Priority). Out-of-range values
// clamp to ERROR. Affects what the QLOG_IF macros forward to the logger
// installed by setLogger().
inline js_value_t* setVerbosity(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;
  using Priority = qvac_lib_inference_addon_cpp::logger::Priority;

  JsArgsParser args(env, info);
  const int32_t level = js::Number(env, args.get(0, "level")).as<int32_t>(env);
  Priority p = Priority::ERROR;
  if (level >= 0 && level <= static_cast<int32_t>(Priority::OFF)) {
    p = static_cast<Priority>(level);
  }
  qvac_lib_infer_vla_ggml::logging::g_verbosityLevel.store(
      p, std::memory_order_relaxed);

  js_value_t* undef = nullptr;
  js_get_undefined(env, &undef);
  return undef;
}
JSCATCH

} // namespace qvac_lib_infer_vla_ggml
