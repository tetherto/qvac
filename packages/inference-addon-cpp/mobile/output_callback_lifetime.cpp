// PORT — KEEP IN SYNC with
// ../tests/integration_js/output-callback-lifetime/binding.cpp.
//
// Body copied verbatim from the desktop binding; the only changes are:
//   * the anonymous namespace becomes the named `output_callback_lifetime` one
//     (so the unified mobile binding can reference these hooks), and
//   * the desktop file's BARE_MODULE registration is dropped — the unified
//     binding.cpp owns module registration.
//
// NOTE ON DEVICE SIGNAL: the JS test driving these hooks is a heap-use-after-free
// stress test whose detection relies on AddressSanitizer, which is NOT available
// in the mobile app. On device it therefore behaves as a "does not crash" smoke
// test (still useful — a crash IS caught, via integration-runtime.cjs's
// crash-to-failure handlers), but it is not equivalent to the desktop
// linux-x64-asan leg. See README.md.

#include "output_callback_lifetime.hpp"

#include <any>
#include <chrono>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>

#include "inference-addon-cpp/JsInterface.hpp"
#include "inference-addon-cpp/JsUtils.hpp"
#include "inference-addon-cpp/ModelInterfaces.hpp"
#include "inference-addon-cpp/addon/AddonJs.hpp"
#include "inference-addon-cpp/handlers/JsOutputHandlerImplementations.hpp"
#include "inference-addon-cpp/queue/OutputCallbackJs.hpp"

namespace output_callback_lifetime {

namespace addon_cpp = qvac_lib_inference_addon_cpp;
namespace js = qvac_lib_inference_addon_cpp::js;

namespace {

class EchoModel : public addon_cpp::model::IModel {
public:
  std::string getName() const override { return "EchoModel"; }

  std::any process(const std::any& input) override {
    return std::any_cast<std::string>(input);
  }

  addon_cpp::RuntimeStats runtimeStats() const override { return {}; }
};

/// Multi-job model whose in-flight jobs block until cancelled. cancel() is
/// deliberately slow so the cancel JsAsyncTask stays alive while the JS
/// thread runs destroyInstance(), making the task's captured
/// shared_ptr<AddonCpp> the last owner: ~AddonCpp then runs on the task
/// thread with terminal events still queued.
class BlockingModel : public addon_cpp::model::IModel,
                      public addon_cpp::model::IModelMultiprocessor,
                      public addon_cpp::model::IModelCancel {
  mutable std::mutex mtx_;
  mutable std::condition_variable cv_;
  mutable bool cancelled_ = false;

public:
  std::string getName() const override { return "BlockingModel"; }

  addon_cpp::RuntimeStats runtimeStats() const override { return {}; }

  std::any process(const std::any& input) override { return input; }

  std::any process(const std::any&, addon_cpp::JobId) override {
    std::unique_lock lk{mtx_};
    cv_.wait(lk, [this] { return cancelled_; });
    throw std::runtime_error("Job cancelled");
  }

  void cancel() const override {
    std::this_thread::sleep_for(std::chrono::milliseconds(30));
    {
      std::scoped_lock lk{mtx_};
      cancelled_ = true;
    }
    cv_.notify_all();
  }
};

std::thread::id moduleInitThreadId;

} // namespace

void recordModuleInitThread() {
  moduleInitThreadId = std::this_thread::get_id();
}

js_value_t* createInstance(js_env_t* env, js_callback_info_t* info) try {
  addon_cpp::JsArgsParser args(env, info);

  addon_cpp::out_handl::OutputHandlers<
      addon_cpp::out_handl::JsOutputHandlerInterface>
      outputHandlers;
  outputHandlers.add(
      std::make_shared<addon_cpp::out_handl::JsStringOutputHandler>());

  auto outputCallback = std::make_unique<addon_cpp::OutputCallBackJs>(
      env,
      args.get(0, "jsHandle"),
      args.getFunction(1, "outputCallback"),
      std::move(outputHandlers));

  auto addon = std::make_unique<addon_cpp::AddonJs>(
      env, std::move(outputCallback), std::make_unique<EchoModel>());

  return addon_cpp::JsInterface::createInstance(env, std::move(addon));
}
JSCATCH

js_value_t* createMultiInstance(js_env_t* env, js_callback_info_t* info) try {
  addon_cpp::JsArgsParser args(env, info);

  addon_cpp::out_handl::OutputHandlers<
      addon_cpp::out_handl::JsOutputHandlerInterface>
      outputHandlers;
  outputHandlers.add(
      std::make_shared<addon_cpp::out_handl::JsStringOutputHandler>());

  auto outputCallback = std::make_unique<addon_cpp::OutputCallBackJs>(
      env,
      args.get(0, "jsHandle"),
      args.getFunction(1, "outputCallback"),
      std::move(outputHandlers));

  auto model = std::make_unique<BlockingModel>();
  auto scheduler = std::make_unique<addon_cpp::MultiJobScheduler>(
      model.get(), 1, model.get(), nullptr);

  auto addon = std::make_unique<addon_cpp::AddonJs>(
      env, std::move(outputCallback), std::move(model), std::move(scheduler));

  return addon_cpp::JsInterface::createInstance(env, std::move(addon));
}
JSCATCH

js_value_t* cancelJob(js_env_t* env, js_callback_info_t* info) try {
  addon_cpp::JsArgsParser args(env, info);
  auto& instance =
      addon_cpp::JsInterface::getInstance(env, args.get(0, "instance"));
  return instance.cancelJob();
}
JSCATCH

js_value_t* onJsThread(js_env_t* env, js_callback_info_t* info) try {
  return js::Boolean::create(
      env, std::this_thread::get_id() == moduleInitThreadId);
}
JSCATCH

js_value_t* runJob(js_env_t* env, js_callback_info_t* info) try {
  addon_cpp::JsArgsParser args(env, info);
  auto& instance =
      addon_cpp::JsInterface::getInstance(env, args.get(0, "instance"));
  auto input = js::String(env, args.get(1, "input")).as<std::string>(env);
  instance.addonCpp->runJob(std::any(std::move(input)));
  return nullptr;
}
JSCATCH

js_value_t* blockEventLoop(js_env_t* env, js_callback_info_t* info) try {
  addon_cpp::JsArgsParser args(env, info);
  const auto ms =
      js::Number(env, args.get(0, "milliseconds")).as<int32_t>(env);
  std::this_thread::sleep_for(std::chrono::milliseconds(ms));
  return nullptr;
}
JSCATCH

} // namespace output_callback_lifetime
