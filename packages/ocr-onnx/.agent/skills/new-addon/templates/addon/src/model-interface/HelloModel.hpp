#pragma once

#include <any>
#include <string>

#include <qvac-lib-inference-addon-cpp/ModelInterfaces.hpp>
#include <qvac-lib-inference-addon-cpp/RuntimeStats.hpp>

namespace {{CPP_NAMESPACE}} {

// Minimal IModel implementation paired with createInstance/runJob in
// AddonJs.hpp. Real addons replace this with a backend-backed model (see
// qvac-lib-infer-llamacpp-embed/addon/src/model-interface/BertModel.hpp for a
// full example) and mix in IModelAsyncLoad when weight streaming is needed.
class HelloModel : public qvac_lib_inference_addon_cpp::model::IModel,
                   public qvac_lib_inference_addon_cpp::model::IModelCancel {
 public:
  using Input = std::string;
  using Output = std::string;
  using OutputType = Output;

  [[nodiscard]] std::string getName() const final { return "HelloModel"; }

  std::any process(const std::any& input) final {
    const auto& text = std::any_cast<const std::string&>(input);
    return std::any(std::string("hello, ") + text);
  }

  [[nodiscard]] qvac_lib_inference_addon_cpp::RuntimeStats
  runtimeStats() const final {
    return {};
  }

  void cancel() const final {}
};

} // namespace {{CPP_NAMESPACE}}
