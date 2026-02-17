#pragma once

#include <onnxruntime_cxx_api.h>

#include "qvac-lib-inference-addon-cpp/Logger.hpp"

namespace onnx_addon {

namespace logger = qvac_lib_inference_addon_cpp::logger;

/**
 * Process-wide singleton for the ONNX Runtime environment.
 * All OnnxSession instances share this single Ort::Env.
 *
 * ONNX Runtime recommends one Ort::Env per process. Creating multiple
 * environments wastes memory and prevents shared thread pools.
 *
 * Thread-safe: Meyers singleton with guaranteed static init ordering.
 */
class OnnxRuntime {
 public:
  OnnxRuntime(const OnnxRuntime&) = delete;
  OnnxRuntime& operator=(const OnnxRuntime&) = delete;
  OnnxRuntime(OnnxRuntime&&) = delete;
  OnnxRuntime& operator=(OnnxRuntime&&) = delete;

  static OnnxRuntime& instance() {
    static OnnxRuntime inst;
    return inst;
  }

  Ort::Env& env() { return env_; }

 private:
  OnnxRuntime() : env_(ORT_LOGGING_LEVEL_WARNING, "qvac-onnx") {
    QLOG(logger::Priority::INFO, "[OnnxRuntime] Singleton environment created");
  }
  ~OnnxRuntime() = default;

  Ort::Env env_;
};

}  // namespace onnx_addon
