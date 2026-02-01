#include <bare.h>
#include <js.h>

#include "qvac-lib-inference-addon-onnx-ocr-fasttext.hpp"

js_value_t* qvacLibInferenceAddonOnnxOcrFasttextExports(js_env_t *env, js_value_t *exports) {

// NOLINTBEGIN(cppcoreguidelines-macro-usage)
#define V(name, fn) \
  { \
    js_value_t *val; \
    if ( js_create_function(env, name, -1, fn, nullptr, &val) != 0) { \
      return nullptr; \
    } \
    if ( js_set_named_property(env, exports, name, val) != 0) { \
      return nullptr; \
    } \
  }

  V("createInstance", qvac_lib_inference_addon_onnx_ocr_fasttext::createInstance)
  V("loadWeights", qvac_lib_inference_addon_onnx_ocr_fasttext::loadWeights)
  V("activate", qvac_lib_inference_addon_onnx_ocr_fasttext::activate)
  V("append", qvac_lib_inference_addon_onnx_ocr_fasttext::append)
  V("status", qvac_lib_inference_addon_onnx_ocr_fasttext::status)
  V("pause", qvac_lib_inference_addon_onnx_ocr_fasttext::pause)
  V("stop", qvac_lib_inference_addon_onnx_ocr_fasttext::stop)
  V("cancel", qvac_lib_inference_addon_onnx_ocr_fasttext::cancel)
  V("destroyInstance", qvac_lib_inference_addon_onnx_ocr_fasttext::destroyInstance)
  V("setLogger", qvac_lib_inference_addon_onnx_ocr_fasttext::setLogger)
  V("releaseLogger", qvac_lib_inference_addon_onnx_ocr_fasttext::releaseLogger)
#undef V
// NOLINTEND(cppcoreguidelines-macro-usage)

  return exports;
}

BARE_MODULE(qvac_lib_inference_addon_onnx_ocr_fasttext, qvacLibInferenceAddonOnnxOcrFasttextExports)
