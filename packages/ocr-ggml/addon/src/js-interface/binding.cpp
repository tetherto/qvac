#include <bare.h>

#include <opencv2/core.hpp>

#include "../addon/AddonJs.hpp"

// OpenCV's default multi-threaded parallel backend installs static globals
// whose destructors race against bare's libuv event-loop teardown — same
// SIGABRT-on-exit pattern as @qvac/ocr-onnx. Force single-threaded mode at
// module load to keep the addon clean on process shutdown.
namespace {
struct OpenCVSingleThread {
  OpenCVSingleThread() { cv::setNumThreads(1); }
} g_opencvInit; // NOLINT(cert-err58-cpp,bugprone-throwing-static-initialization)
} // namespace

js_value_t*
qvac_lib_infer_ocr_ggml_exports( // NOLINT(readability-identifier-naming)
    js_env_t* env, js_value_t* exports) {

// NOLINTBEGIN(cppcoreguidelines-macro-usage)
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

  V("createInstance", qvac_lib_infer_ocr_ggml::createInstance)
  V("runJob", qvac_lib_infer_ocr_ggml::runJob)

  V("loadWeights", qvac_lib_inference_addon_cpp::JsInterface::loadWeights)
  V("activate", qvac_lib_inference_addon_cpp::JsInterface::activate)
  V("cancel", qvac_lib_inference_addon_cpp::JsInterface::cancel)
  V("destroyInstance",
    qvac_lib_inference_addon_cpp::JsInterface::destroyInstance)
  V("setLogger", qvac_lib_inference_addon_cpp::JsInterface::setLogger)
  V("releaseLogger", qvac_lib_inference_addon_cpp::JsInterface::releaseLogger)
#undef V
// NOLINTEND(cppcoreguidelines-macro-usage)

  return exports;
}

BARE_MODULE(qvac - lib - infer - ocr - ggml, qvac_lib_infer_ocr_ggml_exports)
