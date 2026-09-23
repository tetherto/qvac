#pragma once

#include <functional>
#include <memory>
#include <string>
#include <vector>

#include <inference-addon-cpp/ModelInterfaces.hpp>

#include "http/HttpClient.hpp"
#include "protocol/ChatProtocol.hpp"

namespace qvac_llm_sglang {

struct Prompt {
  std::vector<ChatTurn> messages;
  SamplingParams sampling;
  std::function<void(const std::string&)> outputCallback;
};

class SglangModel : public qvac_lib_inference_addon_cpp::model::IModel,
                    public qvac_lib_inference_addon_cpp::model::IModelCancel {
 public:
  explicit SglangModel(std::string baseUrl);

  [[nodiscard]] std::string getName() const override;
  [[nodiscard]] qvac_lib_inference_addon_cpp::RuntimeStats runtimeStats()
      const override;
  std::any process(const std::any& input) override;
  void cancel() const override;

 private:
  Endpoint endpoint_;
  CancelState cancel_;
};

} // namespace qvac_llm_sglang
