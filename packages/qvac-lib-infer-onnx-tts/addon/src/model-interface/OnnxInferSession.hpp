#pragma once

#include "IOnnxInferSession.hpp"
#include "OrtTypes.hpp"
#include "onnxruntime_cxx_api.h"

namespace qvac::ttslib::chatterbox {

class OnnxInferSession : public IOnnxInferSession {
public:
  explicit OnnxInferSession(const std::string &modelPath,
                            bool useGPU = false);
  ~OnnxInferSession() override = default;

  void run() override;

  std::vector<std::string> getInputNames() const override;
  std::vector<std::string> getOutputNames() const override;

  OrtTensor getInput(const std::string &inputName) override;
  OrtTensor getOutput(const std::string &outputName) override;

  void initInputTensors(
      const std::vector<std::vector<int64_t>> &inputShapes) override;

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