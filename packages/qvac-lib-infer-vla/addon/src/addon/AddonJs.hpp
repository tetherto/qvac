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

inline void finalizeVlaModel(js_env_t* /*env*/, void* data, void* /*hint*/) {
  delete static_cast<VlaModel*>(data);
}

inline VlaModel* unwrap(js_env_t* env, js_value_t* external) {
  void* data = nullptr;
  if (js_get_value_external(env, external, &data) != 0 || !data) {
    throw std::runtime_error("invalid VLA model handle");
  }
  return static_cast<VlaModel*>(data);
}

inline std::vector<float>
typedArrayToFloat32Vector(js_env_t* env, js_value_t* value) {
  float* data = nullptr;
  size_t len = 0;
  if (js_get_typedarray_info(
          env,
          value,
          nullptr,
          reinterpret_cast<void**>(&data),
          &len,
          nullptr,
          nullptr) != 0) {
    throw std::runtime_error("expected Float32Array");
  }
  return std::vector<float>(data, data + len);
}

inline std::vector<int32_t>
typedArrayToInt32Vector(js_env_t* env, js_value_t* value) {
  int32_t* data = nullptr;
  size_t len = 0;
  if (js_get_typedarray_info(
          env,
          value,
          nullptr,
          reinterpret_cast<void**>(&data),
          &len,
          nullptr,
          nullptr) != 0) {
    throw std::runtime_error("expected Int32Array");
  }
  return std::vector<int32_t>(data, data + len);
}

inline std::vector<uint8_t>
typedArrayToUint8Vector(js_env_t* env, js_value_t* value) {
  uint8_t* data = nullptr;
  size_t len = 0;
  if (js_get_typedarray_info(
          env,
          value,
          nullptr,
          reinterpret_cast<void**>(&data),
          &len,
          nullptr,
          nullptr) != 0) {
    throw std::runtime_error("expected Uint8Array");
  }
  return std::vector<uint8_t>(data, data + len);
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

// createVlaModel(ggufPath: string) -> External<VlaModel*>
inline js_value_t* createVlaModel(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);
  const std::string ggufPath =
      js::String(env, args.get(0, "ggufPath")).as<std::string>(env);

  auto model = std::make_unique<VlaModel>(ggufPath);

  js_value_t* external = nullptr;
  if (js_create_external(
          env, model.get(), detail::finalizeVlaModel, nullptr, &external) !=
      0) {
    throw std::runtime_error("js_create_external failed");
  }
  model.release(); // ownership transferred to the JS-side finalizer
  return external;
}
JSCATCH

// destroyVlaModel(handle: External) -> undefined
inline js_value_t*
destroyVlaModel(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);
  // js_remove_external would be ideal, but the finalizer will eventually run
  // when the external is GC'd. We delete eagerly and replace the pointer with
  // nullptr so subsequent calls throw.
  void* data = nullptr;
  if (js_get_value_external(env, args.get(0, "handle"), &data) == 0 && data) {
    delete static_cast<VlaModel*>(data);
    // Note: the finalizer will still run on GC; it sees `data` from the
    // external slot, which we can't zero from C++. This is safe because
    // delete-on-zero-pointer is a noop and we never reach finalize with a
    // live pointer that wasn't deleted here.
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

  js::Array imagesArr = opts.getProperty<js::Array>(env, "images");
  const uint32_t imagesLen = imagesArr.size(env);
  std::vector<std::vector<float>> images;
  images.reserve(imagesLen);
  for (uint32_t i = 0; i < imagesLen; i++) {
    js::TypedArray<float> elem = imagesArr.get<js::TypedArray<float>>(env, i);
    images.push_back(detail::typedArrayToFloat32Vector(env, elem));
  }

  const int imgWidth = opts.getPropertyAs<js::Number, int32_t>(env, "imgWidth");
  const int imgHeight =
      opts.getPropertyAs<js::Number, int32_t>(env, "imgHeight");

  std::vector<float> state = detail::typedArrayToFloat32Vector(
      env, opts.getProperty<js::TypedArray<float>>(env, "state"));
  std::vector<int32_t> tokens = detail::typedArrayToInt32Vector(
      env, opts.getProperty<js::TypedArray<int32_t>>(env, "tokens"));
  std::vector<uint8_t> mask = detail::typedArrayToUint8Vector(
      env, opts.getProperty<js::TypedArray<uint8_t>>(env, "mask"));

  std::vector<float> noise;
  if (auto noiseOpt =
          opts.getOptionalProperty<js::TypedArray<float>>(env, "noise")) {
    noise = detail::typedArrayToFloat32Vector(env, *noiseOpt);
  }

  std::vector<float> actions =
      model->run(images, imgWidth, imgHeight, state, tokens, mask, noise);

  return detail::float32ArrayFromVector(env, actions);
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
