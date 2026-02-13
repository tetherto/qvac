#pragma once

#include "onnxruntime_cxx_api.h"

namespace qvac::ttslib::chatterbox {

enum class OrtElementType {
  Fp16 = 0,
  Fp32 = 1,
  Fp64 = 2,
  Int4 = 3,
  Int8 = 4,
  Int16 = 5,
  Int32 = 6,
  Int64 = 7,
  UInt4 = 8,
  UInt8 = 9,
  UInt16 = 10,
  UInt32 = 11,
  UInt64 = 12
};

struct OrtTensor {
  void *data;
  std::string name;
  std::vector<int64_t> shape;
  OrtElementType type;
};

class OnnxInferSession {
public:
  OnnxInferSession(const std::string &modelPath);
  ~OnnxInferSession() = default;

  void run();

  std::vector<std::string> getInputNames() const;
  std::vector<std::string> getOutputNames() const;

  OrtTensor getInput(const std::string &inputName);
  OrtTensor getOutput(const std::string &outputName);

  void initInputTensors(const std::vector<std::vector<int64_t>> &inputShapes);

private:
  std::unique_ptr<Ort::Session> session_;

  std::vector<OrtTensor> inputTensors_;
  std::vector<OrtTensor> outputTensors_;

  std::vector<Ort::Value> inputTensorsValues_;
  std::vector<Ort::Value> outputsTensorsValues_;

  std::vector<std::string> inputNames_;
  std::vector<std::string> outputNames_;

  Ort::AllocatorWithDefaultOptions allocator_;
};

} // namespace qvac::ttslib::chatterbox