#pragma once

#include <cmath>
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

// Resolve the instance handle to the VlaModel, or null if it refers to some
// other model type. runJob's dispatch bookkeeping uses this: a wrong model type
// is not this function's business, so it returns null rather than throwing.
//
// NOT noexcept: getInstance still throws StatusError for a handle it does not
// know, and this is the first thing runJob does that touches that argument. A
// noexcept here would turn an invalid handle — reachable by exactly the direct
// binding callers the in-flight guard exists for — into std::terminate instead
// of the catchable JS error JSCATCH already produces.
inline VlaModel*
vlaFromInstanceOrNull(js_env_t* env, js_value_t* instanceHandle) {
  using namespace qvac_lib_inference_addon_cpp;
  return dynamic_cast<VlaModel*>(
      &JsInterface::getInstance(env, instanceHandle).addonCpp->model.get());
}

// Parse an optional integer that arrived as a config-map string ("" = unset,
// returned as -1). createInstance's config map is all strings (ggufPath,
// backend, backendsDir, …), so the embodiment's numeric id and camera-count
// override come through the same way rather than as JS numbers.
// `max` is inclusive; an out-of-range or malformed value is an error, never a
// truncation (std::stoi throws out_of_range on a value past int, and a value
// past `max` cannot name anything the resolver would accept).
inline int
parseOptionalConfigInt(const std::string& s, const char* what, int max) {
  if (s.empty()) {
    return -1;
  }
  size_t used = 0;
  int value = 0;
  try {
    value = std::stoi(s, &used);
  } catch (const std::exception&) {
    used = 0;
  }
  if (used != s.size() || value < 0 || value > max) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        std::string(what) + " must be an integer in 0.." + std::to_string(max) +
            ", got '" + s + "'");
  }
  return value;
}

// Largest selectable embodiment id / camera count, mirroring
// GROOT_MAX_EMBODIMENT_CAT_ID and GROOT_MAX_SANE_NUM_CAMERAS in groot.cpp.
// Checked at the JS boundary as well, because a JS number reaching the resolver
// as int32 would otherwise NARROW: 2^32 arrives as 0, i.e. a silent selection
// of a different embodiment. Anything out of range must be an error, never a
// cast.
constexpr double VLA_MAX_EMBODIMENT_CAT_ID = 31;
constexpr double VLA_MAX_NUM_CAMERAS = 64;

// Read a non-negative integer JS number, rejecting a non-integral or
// out-of-range value instead of narrowing it. `max` is inclusive.
inline int
jsBoundedInt(js_env_t* env, js_value_t* value, const char* what, double max) {
  const double raw =
      qvac_lib_inference_addon_cpp::js::Number(env, value).as<double>(env);
  if (!(raw >= 0) || raw > max || raw != std::floor(raw)) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        std::string(what) + " must be an integer in 0.." +
            std::to_string(static_cast<long long>(max)) + ", got " +
            std::to_string(raw));
  }
  return static_cast<int>(raw);
}

// Read the embodiment selector out of the createInstance config map. All three
// keys are always present (index.js writes '' when unconfigured).
inline VlaEmbodimentRequest
parseEmbodimentRequest(qvac_lib_inference_addon_cpp::JsArgsParser& args) {
  VlaEmbodimentRequest req;
  req.tag = args.getMapEntry(1, "embodiment");
  req.cat_id = parseOptionalConfigInt(
      args.getMapEntry(1, "embodimentCatId"),
      "embodimentCatId",
      static_cast<int>(VLA_MAX_EMBODIMENT_CAT_ID));
  const int cams = parseOptionalConfigInt(
      args.getMapEntry(1, "embodimentNumCameras"),
      "embodimentNumCameras",
      static_cast<int>(VLA_MAX_NUM_CAMERAS));
  req.num_cameras = cams > 0 ? cams : 0;
  return req;
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

// Builds the JS-side hparams object (field mapping documented on
// getVlaHparams). Shared with setVlaEmbodiment so a switched model's refreshed
// hparams go through exactly one mapping.
inline js_value_t* hparamsToJs(js_env_t* env, const VlaHparamsGeneric& hp) {
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
  setInt("imagePatchElems", hp.image_patch_elems);
  setStr(
      "stateInputMode",
      hp.state_input_mode == VlaHparamsGeneric::StateInputMode::Discrete
          ? "discrete"
          : "continuous");
  setStr(
      "imageInputMode",
      hp.image_input_mode == VlaHparamsGeneric::ImageInputMode::Patches
          ? "patches"
          : "pixels");
  // GR00T only — omitted for models that resolve no embodiment (SmolVLA, π₀.₅,
  // or a GR00T GGUF naming none), so the key's presence signals an embodiment
  // was selected, NOT that it can be changed: a single-embodiment GGUF reports
  // its baked tag here and still rejects every setEmbodiment(). The cat_id is
  // the numeric form of the same selection, so a caller can round-trip either
  // way.
  if (!hp.selected_embodiment_tag.empty()) {
    setStr("selectedEmbodimentTag", hp.selected_embodiment_tag.c_str());
  }
  if (hp.selected_embodiment_cat_id >= 0) {
    setInt("selectedEmbodimentCatId", hp.selected_embodiment_cat_id);
  }
  return obj;
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
  // Embodiment selector for multi-embodiment GR00T GGUFs; all keys empty = the
  // GGUF's default. index.js always sets them (empty when unconfigured).
  const VlaEmbodimentRequest embodiment = detail::parseEmbodimentRequest(args);
  const bool forceCpu = (backend == "cpu");

  auto model =
      std::make_unique<VlaModel>(ggufPath, forceCpu, backendsDir, embodiment);

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
  js_value_t* instanceHandle = args.get(0, "instance");
  // Count the job in BEFORE handing it over, so there is no window in which the
  // scheduler has accepted a job that setVlaEmbodiment cannot see (it would
  // otherwise be free to swap the weights this job is about to read). Released
  // again below if the job was refused, and by process() once it completes.
  VlaModel* vla = detail::vlaFromInstanceOrNull(env, instanceHandle);
  if (vla != nullptr) {
    vla->noteJobDispatched();
  }
  bool accepted = false;
  try {
    // Straight to addonCpp (what the framework's instance.runJob does under its
    // js::Boolean wrapper) so acceptance is a plain bool rather than a JS value
    // that would have to be read back to decide whether to release the count.
    accepted = JsInterface::getInstance(env, instanceHandle)
                   .addonCpp->runJob(std::move(input));
  } catch (...) {
    if (vla != nullptr) {
      vla->noteJobSettled();
    }
    throw;
  }
  // runJob returns false when a previous job is still in flight — that job was
  // never queued, so process() will never clear its count.
  if (vla != nullptr && !accepted) {
    vla->noteJobSettled();
  }
  return js::Boolean::create(env, accepted);
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
//                              visionImageSize, numCameras, imagePatchElems,
//                              stateInputMode, imageInputMode,
//                              selectedEmbodimentTag? }
//
// `numCameras`, `stateInputMode`, and `imageInputMode` let JS-side input
// validation tell the architectures apart: SmolVLA (2 cameras, continuous
// state, pixel images), π₀.₅ (up to 3 cameras, discrete state inlined into
// the prompt), and GR00T (continuous state, pre-patchified images ->
// imageInputMode "patches"). `imagePatchElems` is the exact per-camera patch
// buffer length the patches-path validator checks against (0 on pixel models).
inline js_value_t* getVlaHparams(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);
  VlaModel& model = detail::vlaFromInstance(env, args.get(0, "instance"));
  return detail::hparamsToJs(env, model.hparams());
}
JSCATCH

// setVlaEmbodiment(instance, embodiment, numCameras) -> hparams object
//
// Switches a loaded multi-embodiment GR00T model to another embodiment shipped
// in the same GGUF, so one load can serve any of them (~20MB of row I/O instead
// of a full reload). `embodiment` is either a tag string or the numeric cat_id;
// `numCameras` (0 = unset) overrides the GGUF's camera count for that
// embodiment, which is what makes a row whose count was unknown at conversion
// time selectable. Returns the refreshed hparams — `numCameras`,
// `selectedEmbodimentTag` and `selectedEmbodimentCatId` follow the new
// embodiment, and the JS wrapper caches the result for its run-input
// validation. Throws for an unknown/unshipped tag or id, an embodiment with no
// known camera count and no override, a single-embodiment model, or an
// inference job still in flight (VlaModel::setEmbodiment enforces that last one
// natively, so it holds for callers that never go through index.js).
inline js_value_t*
setVlaEmbodiment(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);
  VlaModel& model = detail::vlaFromInstance(env, args.get(0, "instance"));
  js_value_t* selector = args.get(1, "embodiment");
  VlaEmbodimentRequest req;
  if (js::is<js::Number>(env, selector)) {
    req.cat_id = detail::jsBoundedInt(
        env, selector, "embodiment catId", detail::VLA_MAX_EMBODIMENT_CAT_ID);
  } else {
    req.tag = js::String(env, selector).as<std::string>(env);
  }
  const int cams = detail::jsBoundedInt(
      env,
      args.get(2, "numCameras"),
      "numCameras",
      detail::VLA_MAX_NUM_CAMERAS);
  req.num_cameras = cams > 0 ? cams : 0;
  model.setEmbodiment(req);
  return detail::hparamsToJs(env, model.hparams());
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
