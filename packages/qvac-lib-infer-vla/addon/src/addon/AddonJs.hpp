#pragma once

#include <cstring>
#include <memory>
#include <span>
#include <string>
#include <vector>

#include <qvac-lib-inference-addon-cpp/JsInterface.hpp>
#include <qvac-lib-inference-addon-cpp/JsUtils.hpp>

#include "AddonCpp.hpp"

namespace qvac_lib_infer_vla {

namespace detail {

// Indirection wrapper so an explicit `destroyVlaModel` can null out the inner
// model pointer while leaving the heap object reachable for the GC finalizer.
// Without this, `js_create_external` stores a pointer the C++ side cannot zero,
// and a GC finalizer running after `destroyVlaModel` would re-`delete` a
// dangling `VlaModel*`.
struct VlaHandle {
  VlaModel* model = nullptr;
};

inline void finalizeVlaModel(js_env_t* /*env*/, void* data, void* /*hint*/) {
  auto* handle = static_cast<VlaHandle*>(data);
  if (handle == nullptr) return;
  delete handle->model;
  handle->model = nullptr;
  delete handle;
}

inline VlaModel* unwrap(js_env_t* env, js_value_t* external) {
  void* data = nullptr;
  if (js_get_value_external(env, external, &data) != 0 || data == nullptr) {
    throw std::runtime_error("invalid VLA model handle");
  }
  auto* handle = static_cast<VlaHandle*>(data);
  if (handle->model == nullptr) {
    throw std::runtime_error("VLA model has been destroyed");
  }
  return handle->model;
}

// Zero-copy view into a JS TypedArray's underlying ArrayBuffer. The pointer is
// only valid for the duration of the surrounding native call (no JS callbacks
// in flight), which is the contract the inference path already relies on.
template <typename T>
inline std::pair<const T*, size_t>
typedArrayPtr(js_env_t* env, js_value_t* value, const char* expectedKind) {
  T* data = nullptr;
  size_t len = 0;
  if (js_get_typedarray_info(
          env,
          value,
          nullptr,
          reinterpret_cast<void**>(&data),
          &len,
          nullptr,
          nullptr) != 0) {
    throw std::runtime_error(std::string("expected ") + expectedKind);
  }
  return {data, len};
}

inline js_value_t*
float32ArrayFromVector(js_env_t* env, const std::vector<float>& data) {
  js_value_t* arrayBuffer = nullptr;
  void* arrayBufferData = nullptr;
  const size_t byteLen = data.size() * sizeof(float);
  if (js_create_arraybuffer(env, byteLen, &arrayBufferData, &arrayBuffer) !=
      0) {
    throw std::runtime_error("js_create_arraybuffer failed");
  }
  if (byteLen > 0) {
    std::memcpy(arrayBufferData, data.data(), byteLen);
  }
  js_value_t* typedArray = nullptr;
  if (js_create_typedarray(
          env, js_float32array, data.size(), arrayBuffer, 0, &typedArray) !=
      0) {
    throw std::runtime_error("js_create_typedarray failed");
  }
  return typedArray;
}

} // namespace detail

// createVlaModel(ggufPath: string) -> External<VlaHandle*>
inline js_value_t* createVlaModel(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);
  const std::string ggufPath =
      js::String(env, args.get(0, "ggufPath")).as<std::string>(env);

  auto model = std::make_unique<VlaModel>(ggufPath);
  auto handle = std::make_unique<detail::VlaHandle>();
  handle->model = model.release();

  js_value_t* external = nullptr;
  if (js_create_external(
          env, handle.get(), detail::finalizeVlaModel, nullptr, &external) !=
      0) {
    delete handle->model;
    throw std::runtime_error("js_create_external failed");
  }
  handle.release(); // ownership transferred to the JS-side finalizer
  return external;
}
JSCATCH

// destroyVlaModel(handle: External) -> undefined
//
// Eagerly frees the underlying VlaModel and zeroes the inner pointer in the
// VlaHandle wrapper. The handle itself stays alive until the JS engine GCs the
// external; finalizeVlaModel then frees the empty handle. Subsequent calls on
// the same external throw via the unwrap() guard rather than UB on a freed
// pointer.
inline js_value_t*
destroyVlaModel(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);
  void* data = nullptr;
  if (js_get_value_external(env, args.get(0, "handle"), &data) == 0 &&
      data != nullptr) {
    auto* handle = static_cast<detail::VlaHandle*>(data);
    delete handle->model;
    handle->model = nullptr;
  }
  js_value_t* undef = nullptr;
  js_get_undefined(env, &undef);
  return undef;
}
JSCATCH

// runVlaModel(handle, opts) -> Float32Array
//   opts: {
//     images: Float32Array[],        // each is contiguous CHW, length 3*H*W
//     imgWidth: number,
//     imgHeight: number,
//     state: Float32Array,
//     tokens: Int32Array,
//     mask: Uint8Array,              // attention mask (0/1), same length as
//     tokens noise?: Float32Array,          // optional (chunk_size ×
//     max_action_dim)
//   }
inline js_value_t* runVlaModel(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);
  VlaModel* model = detail::unwrap(env, args.get(0, "handle"));
  js::Object opts(env, args.get(1, "opts"));

  // Zero-copy: walk the images array and capture each underlying ArrayBuffer
  // pointer. Pointers stay valid for the duration of this synchronous call
  // because the JS engine is paused in the native callback.
  js::Array imagesArr = opts.getProperty<js::Array>(env, "images");
  const uint32_t imagesLen = imagesArr.size(env);
  std::vector<const float*> imagePtrs(imagesLen);
  for (uint32_t i = 0; i < imagesLen; i++) {
    js::TypedArray<float> elem = imagesArr.get<js::TypedArray<float>>(env, i);
    auto [ptr, len] = detail::typedArrayPtr<float>(env, elem, "Float32Array");
    (void)len;
    imagePtrs[i] = ptr;
  }

  const int imgWidth = opts.getPropertyAs<js::Number, int32_t>(env, "imgWidth");
  const int imgHeight =
      opts.getPropertyAs<js::Number, int32_t>(env, "imgHeight");

  auto [statePtr, stateLen] = detail::typedArrayPtr<float>(
      env, opts.getProperty<js::TypedArray<float>>(env, "state"),
      "Float32Array");
  auto [tokensPtr, tokensLen] = detail::typedArrayPtr<int32_t>(
      env, opts.getProperty<js::TypedArray<int32_t>>(env, "tokens"),
      "Int32Array");
  auto [maskPtr, maskLen] = detail::typedArrayPtr<uint8_t>(
      env, opts.getProperty<js::TypedArray<uint8_t>>(env, "mask"),
      "Uint8Array");

  const float* noisePtr = nullptr;
  size_t noiseLen = 0;
  if (auto noiseOpt =
          opts.getOptionalProperty<js::TypedArray<float>>(env, "noise")) {
    std::tie(noisePtr, noiseLen) =
        detail::typedArrayPtr<float>(env, *noiseOpt, "Float32Array");
  }

  VlaModel::RunResult result = model->run(
      imagePtrs.data(), static_cast<int>(imagesLen), imgWidth, imgHeight,
      statePtr, static_cast<int>(stateLen), tokensPtr,
      static_cast<int>(tokensLen), maskPtr, static_cast<int>(maskLen), noisePtr,
      static_cast<int>(noiseLen));

  js_value_t* obj = nullptr;
  if (js_create_object(env, &obj) != 0) {
    throw std::runtime_error("js_create_object failed");
  }

  js_value_t* actionsArr = detail::float32ArrayFromVector(env, result.actions);
  if (js_set_named_property(env, obj, "actions", actionsArr) != 0) {
    throw std::runtime_error("js_set_named_property(actions) failed");
  }

  js_value_t* stats = nullptr;
  if (js_create_object(env, &stats) != 0) {
    throw std::runtime_error("js_create_object(stats) failed");
  }
  auto setDouble = [&](const char* name, double value) {
    js_value_t* v = nullptr;
    js_create_double(env, value, &v);
    js_set_named_property(env, stats, name, v);
  };
  setDouble("vision_ms", result.timing.vision_ms);
  setDouble("smollm2_compute_ms", result.timing.smollm2_compute_ms);
  setDouble("smollm2_total_ms", result.timing.smollm2_total_ms);
  setDouble("ode_ms", result.timing.ode_ms);
  setDouble("total_ms", result.timing.total_ms);
  if (js_set_named_property(env, obj, "stats", stats) != 0) {
    throw std::runtime_error("js_set_named_property(stats) failed");
  }

  return obj;
}
JSCATCH

// getVlaHparams(handle) -> { chunkSize, actionDim, maxActionDim, maxStateDim,
//                            tokenizerMaxLength, visionImageSize }
inline js_value_t* getVlaHparams(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);
  VlaModel* model = detail::unwrap(env, args.get(0, "handle"));
  const smolvla_hparams& hp = model->hparams();

  js_value_t* obj = nullptr;
  if (js_create_object(env, &obj) != 0) {
    throw std::runtime_error("js_create_object failed");
  }
  auto setInt = [&](const char* name, int32_t value) {
    js_value_t* v = nullptr;
    js_create_int32(env, value, &v);
    js_set_named_property(env, obj, name, v);
  };
  setInt("chunkSize", hp.chunk_size);
  setInt("actionDim", hp.action_dim);
  setInt("maxActionDim", hp.max_action_dim);
  setInt("maxStateDim", hp.max_state_dim);
  setInt("tokenizerMaxLength", hp.tokenizer_max_length);
  setInt("visionImageSize", hp.vision_image_size);
  return obj;
}
JSCATCH

} // namespace qvac_lib_infer_vla
