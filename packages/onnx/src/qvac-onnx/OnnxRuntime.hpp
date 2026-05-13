#pragma once

#include <onnxruntime_cxx_api.h>

#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

#include "Logger.hpp"
#include "OnnxConfig.hpp"

namespace onnx_addon {

/**
 * Process-wide singleton for the ONNX Runtime environment.
 * All OnnxSession instances share this single Ort::Env.
 *
 * ONNX Runtime recommends one Ort::Env per process. Creating multiple
 * environments wastes memory and prevents shared thread pools.
 *
 * Thread-safe: Meyers singleton with guaranteed static init ordering.
 *
 * Call configure() before the first instance() call to customize logging
 * level and identifier. If not called, defaults are used.
 */
class OnnxRuntime {
 public:
  OnnxRuntime(const OnnxRuntime&) = delete;
  OnnxRuntime& operator=(const OnnxRuntime&) = delete;
  OnnxRuntime(OnnxRuntime&&) = delete;
  OnnxRuntime& operator=(OnnxRuntime&&) = delete;

  /// Configure the environment before first use. Throws if already initialized.
  static void configure(const EnvironmentConfig& cfg) {
    std::scoped_lock lock{configMtx_()};
    if (initialized_()) {
      throw std::runtime_error(
          "OnnxRuntime::configure() must be called before the first "
          "instance() call");
    }
    pendingConfig_() = cfg;
  }

  static OnnxRuntime& instance() {
    static OnnxRuntime inst{resolveConfig_()};
    return inst;
  }

  Ort::Env& env() { return env_; }

  /// Returns the list of available execution providers from ONNX Runtime.
  static std::vector<std::string> getAvailableProviders() {
    return Ort::GetAvailableProviders();
  }

 private:
  explicit OnnxRuntime(const EnvironmentConfig& cfg)
      : env_(toOrtLevel(cfg.loggingLevel), cfg.loggingId.c_str()) {
    std::scoped_lock lock{configMtx_()};
    initialized_() = true;
    QLOG(logger::Priority::INFO, "[OnnxRuntime] Singleton environment created");
  }
  ~OnnxRuntime() = default;

  static OrtLoggingLevel toOrtLevel(LoggingLevel level) {
    switch (level) {
      case LoggingLevel::VERBOSE: return ORT_LOGGING_LEVEL_VERBOSE;
      case LoggingLevel::INFO:    return ORT_LOGGING_LEVEL_INFO;
      case LoggingLevel::WARNING: return ORT_LOGGING_LEVEL_WARNING;
      case LoggingLevel::ERROR:   return ORT_LOGGING_LEVEL_ERROR;
      case LoggingLevel::FATAL:   return ORT_LOGGING_LEVEL_FATAL;
    }
    return ORT_LOGGING_LEVEL_WARNING;
  }

  static EnvironmentConfig resolveConfig_() {
    std::scoped_lock lock{configMtx_()};
    if (pendingConfig_()) return *pendingConfig_();
    return EnvironmentConfig{};
  }

  // Static storage via function-local statics to avoid SIOF
  static std::mutex& configMtx_() {
    static std::mutex mtx;
    return mtx;
  }
  static std::optional<EnvironmentConfig>& pendingConfig_() {
    static std::optional<EnvironmentConfig> cfg;
    return cfg;
  }
  static bool& initialized_() {
    static bool init = false;
    return init;
  }

  Ort::Env env_;
};

}  // namespace onnx_addon
