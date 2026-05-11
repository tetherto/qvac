#pragma once

#include <string>

namespace onnx_addon {

enum class ExecutionProvider {
  CPU,
  AUTO_GPU,  // Auto-select based on platform (NNAPI/CoreML/DirectML)
  NNAPI,     // Android
  CoreML,    // Apple
  DirectML   // Windows
};

enum class GraphOptimizationLevel {
  DISABLE,
  BASIC,
  EXTENDED,
  ALL
};

enum class LoggingLevel {
  VERBOSE,
  INFO,
  WARNING,
  ERROR,
  FATAL
};

enum class ExecutionMode {
  SEQUENTIAL,
  PARALLEL
};

struct EnvironmentConfig {
  LoggingLevel loggingLevel =
      LoggingLevel::ERROR; // Suppress ORT EP node-assignment warnings
  std::string loggingId = "qvac-onnx";
};

struct SessionConfig {
  ExecutionProvider provider = ExecutionProvider::AUTO_GPU;
  GraphOptimizationLevel optimization = GraphOptimizationLevel::EXTENDED;
  int intraOpThreads = 0;  // 0 = auto (use all available cores)
  int interOpThreads = 0;  // 0 = auto
  bool enableMemoryPattern = true;
  bool enableCpuMemArena = true;
  bool enableXnnpack =
      false; // XNNPack EP (opt-in: may cause node fallback warnings)
  ExecutionMode executionMode = ExecutionMode::SEQUENTIAL;
};

inline std::string providerToString(ExecutionProvider provider) {
  switch (provider) {
    case ExecutionProvider::CPU:      return "CPU";
    case ExecutionProvider::AUTO_GPU: return "AUTO_GPU";
    case ExecutionProvider::NNAPI:    return "NNAPI";
    case ExecutionProvider::CoreML:   return "CoreML";
    case ExecutionProvider::DirectML: return "DirectML";
  }
  return "UNKNOWN";
}

inline std::string optimizationToString(GraphOptimizationLevel level) {
  switch (level) {
    case GraphOptimizationLevel::DISABLE:  return "DISABLE";
    case GraphOptimizationLevel::BASIC:    return "BASIC";
    case GraphOptimizationLevel::EXTENDED: return "EXTENDED";
    case GraphOptimizationLevel::ALL:      return "ALL";
  }
  return "UNKNOWN";
}

}  // namespace onnx_addon
