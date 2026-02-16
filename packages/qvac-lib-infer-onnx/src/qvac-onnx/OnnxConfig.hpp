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

struct SessionConfig {
  ExecutionProvider provider = ExecutionProvider::AUTO_GPU;
  GraphOptimizationLevel optimization = GraphOptimizationLevel::EXTENDED;
  int intraOpThreads = 0;  // 0 = auto (use all available cores)
  int interOpThreads = 0;  // 0 = auto
  bool enableMemoryPattern = true;
  bool enableCpuMemArena = true;
  bool enableXnnpack = true;  // XNNPack EP for optimized CPU inference
};

}  // namespace onnx_addon
