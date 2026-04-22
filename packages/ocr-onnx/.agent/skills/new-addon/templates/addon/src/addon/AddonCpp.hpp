#pragma once

#include <memory>
#include <string>

#include <qvac-lib-inference-addon-cpp/ModelInterfaces.hpp>
#include <qvac-lib-inference-addon-cpp/addon/AddonCpp.hpp>
#include <qvac-lib-inference-addon-cpp/handlers/OutputHandler.hpp>
#include <qvac-lib-inference-addon-cpp/queue/OutputCallbackCpp.hpp>
#include <qvac-lib-inference-addon-cpp/queue/OutputCallbackInterface.hpp>

#include "../model-interface/HelloModel.hpp"

namespace {{CPP_NAMESPACE}} {

// Pure-synchronous greeter used by the hello-world demo (exercised by
// test/unit/test_hello.cpp). Not part of the IModel pattern.
class HelloWorld {
 public:
  static std::string greet(const std::string& name) {
    return "hello, " + name;
  }
};

// Parallel to AddonJs::createInstance but without any JS dependencies. Use
// this from CLI tools or pure C++ tests that want to exercise the full Model
// pipeline without a JS env. Replace HelloModel with your Model when extending.
struct AddonInstance {
  std::unique_ptr<qvac_lib_inference_addon_cpp::AddonCpp> addon;
  std::shared_ptr<qvac_lib_inference_addon_cpp::out_handl::
                      CppQueuedOutputHandler<std::string>>
      outputHandler;
};

inline AddonInstance createInstance() {
  using namespace qvac_lib_inference_addon_cpp;

  auto model = std::make_unique<HelloModel>();

  auto outHandler =
      std::make_shared<out_handl::CppQueuedOutputHandler<std::string>>();
  out_handl::OutputHandlers<out_handl::OutputHandlerInterface<void>>
      outHandlers;
  outHandlers.add(outHandler);
  std::unique_ptr<OutputCallBackInterface> callback =
      std::make_unique<OutputCallBackCpp>(std::move(outHandlers));

  auto addon = std::make_unique<AddonCpp>(std::move(callback), std::move(model));

  return {.addon = std::move(addon), .outputHandler = std::move(outHandler)};
}

} // namespace {{CPP_NAMESPACE}}
