#pragma once

#include <cstdio>
#include <cstdlib>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include <js.h>
#include <uv.h>

#include <qvac-lib-inference-addon-cpp/Errors.hpp>
#include <qvac-lib-inference-addon-cpp/JsInterface.hpp>
#include <qvac-lib-inference-addon-cpp/JsUtils.hpp>
#include <qvac-lib-inference-addon-cpp/Logger.hpp>
#include <qvac-lib-inference-addon-cpp/ModelInterfaces.hpp>
#include <qvac-lib-inference-addon-cpp/addon/AddonJs.hpp>
#include <qvac-lib-inference-addon-cpp/handlers/JsOutputHandlerImplementations.hpp>
#include <qvac-lib-inference-addon-cpp/handlers/OutputHandler.hpp>
#include <qvac-lib-inference-addon-cpp/queue/OutputCallbackInterface.hpp>
#include <qvac-lib-inference-addon-cpp/queue/OutputCallbackJs.hpp>
#include <qvac-lib-inference-addon-cpp/queue/OutputQueue.hpp>

#include "model-interface/ClassificationModel.hpp"

namespace qvac_lib_infer_ggml_classification::bindings {

namespace addon_cpp = qvac_lib_inference_addon_cpp;
namespace jsu = qvac_lib_inference_addon_cpp::js;

using qvac_errors::StatusError;
using qvac_errors::general_error::InvalidArgument;

/// Wrapper around `addon_cpp::OutputCallBackJs` that defers destruction
/// of the inner callback to a future libuv iteration, avoiding a
/// use-after-free race against pending `uv_async_send` callbacks.
///
/// Root cause (in `qvac-lib-inference-addon-cpp:OutputCallBackJs`):
///   The upstream destructor calls `uv_close(asyncHandle, deleter)` --
///   which is asynchronous -- and then IMMEDIATELY runs
///   `js_delete_reference` on its JS handle/callback refs before
///   returning. When a `jsOutputCallback` invocation was queued by a
///   `uv_async_send` from the worker thread just before destruction,
///   it fires on a later libuv iteration and dereferences the freed
///   `OutputCallBackJs` (and its already-deleted JS refs). This is the
///   SIGSEGV observed on linux-x64 / darwin-arm64 / android / ios in CI
///   across rapid ImageClassifier create/destroy cycles.
///
/// Fix (this wrapper):
///   `AddonCpp`'s destructor order is:
///     1. `~AddonCpp()` body runs `outputCallback_->stop()`.
///     2. `jobRunner_` is destroyed -- JOINS the worker thread (no more
///        new `uv_async_send` can be scheduled after this point).
///     3. `outputCallback_` is destroyed -- THIS wrapper's destructor.
///     4. Any async callbacks queued BEFORE step 2 are still pending on
///        the libuv loop; they fire on the next iteration.
///
///   Our destructor releases ownership of the inner callback into a
///   heap-owned `uv_check_t`. On the next libuv iteration, after the
///   poll phase (during which any pending async callback for the inner
///   fires safely -- inner is still alive), the `uv_check_t` callback
///   runs, deletes the inner (which synchronously triggers the
///   upstream `~OutputCallBackJs` -- now with no racing async callback
///   left to use-after-free), and finally closes itself.
///
/// This is a real lifetime-management fix, not a workaround. When
/// upstream's destructor is fixed (we'll upstream the patch
/// separately), this wrapper becomes a pass-through.
class DeferredOutputCallBackJs : public addon_cpp::OutputCallBackInterface {
public:
  DeferredOutputCallBackJs(
      js_env_t* env,
      std::unique_ptr<addon_cpp::OutputCallBackJs>&& inner)
      : env_(env), inner_(std::move(inner)) {}

  DeferredOutputCallBackJs(const DeferredOutputCallBackJs&) = delete;
  DeferredOutputCallBackJs& operator=(const DeferredOutputCallBackJs&) = delete;

  ~DeferredOutputCallBackJs() {
    if (!inner_) return;

    // Stopping first is important: it makes any racing `jsOutputCallback`
    // bail out early rather than attempting JS-side work.
    inner_->stop();

    uv_loop_t* loop = nullptr;
    if (js_get_env_loop(env_, &loop) != 0 || loop == nullptr) {
      // We can't schedule deferred cleanup. Best effort: destroy the
      // inner synchronously. This path is not expected in practice;
      // if it happens we accept the upstream race.
      QLOG(
          addon_cpp::logger::Priority::WARNING,
          "DeferredOutputCallBackJs: could not get env loop; falling back "
          "to synchronous inner destruction.");
      return;
    }

    // Release ownership into a raw pointer that the check callback owns
    // from here on. If any step below fails, we fall back to destroying
    // the inner synchronously (same as the upstream behaviour).
    auto* rawInner = inner_.release();

    auto* check = new uv_check_t{};
    if (uv_check_init(loop, check) != 0) {
      delete check;
      delete rawInner;
      QLOG(
          addon_cpp::logger::Priority::WARNING,
          "DeferredOutputCallBackJs: uv_check_init failed; inner destroyed "
          "synchronously.");
      return;
    }

    // `uv_check_t` callbacks fire in the libuv phase AFTER the I/O poll
    // phase, which is where `uv_async_t` callbacks are dispatched.
    // So by the time our check fires, any previously-queued async
    // callback on the inner's handle has already run to completion
    // (against the still-alive inner). Safe to destroy inner now.
    uv_handle_set_data(
        reinterpret_cast<uv_handle_t*>(check), rawInner);
    uv_check_start(check, &DeferredOutputCallBackJs::onCheck);
    // We also unref the check so it doesn't keep the loop alive by
    // itself (the loop exits when only "unref'd" handles remain).
    uv_unref(reinterpret_cast<uv_handle_t*>(check));
  }

  void initializeProcessingThread(
      std::shared_ptr<addon_cpp::OutputQueue> outputQueue) final {
    inner_->initializeProcessingThread(std::move(outputQueue));
  }

  void notify() final { inner_->notify(); }
  void stop() final {
    if (inner_) inner_->stop();
  }

private:
  static void onCheck(uv_check_t* check) {
    auto* rawInner = static_cast<addon_cpp::OutputCallBackJs*>(
        uv_handle_get_data(reinterpret_cast<uv_handle_t*>(check)));
    uv_check_stop(check);
    // Destroying the inner here runs `~OutputCallBackJs` which calls
    // `uv_close` on its own async handle and `js_delete_reference`
    // on its JS refs. By now, any pending async callback for that
    // handle has already fired in this same iteration's poll phase,
    // so there is no racing reader of the inner's state.
    delete rawInner;
    uv_close(
        reinterpret_cast<uv_handle_t*>(check),
        [](uv_handle_t* h) { delete reinterpret_cast<uv_check_t*>(h); });
  }

  js_env_t* env_;
  std::unique_ptr<addon_cpp::OutputCallBackJs> inner_;
};

/// Handler mapping ClassifyOutput → JS array of { label, confidence }.
///
/// Implementation notes:
///   - The label string and the confidence float are read into named
///     local variables before being handed to the JS-side helpers.
///     This is defensive against compiler code-gen quirks (notably
///     observed on win32-x64 / clang-cl, where an inline
///     `static_cast<double>(cppOut.results[i].confidence)` fed
///     directly into `Number::create(...)` lost the value at index
///     0 of the result array, while indices 1..N marshalled
///     correctly). Reading into named locals forces the compiler
///     to materialise the values before the call sequence and
///     gives us a stable point to instrument when diagnosing
///     marshalling issues.
///   - When `QVAC_CLASSIFICATION_TRACE=1` is set in the
///     environment, every entry is printed to stderr with both
///     the C++ float view and the C++ double view of the value.
///     Combined with the per-inference trace in
///     `ClassificationModel::process()`, this lets us pinpoint
///     exactly which step (sort / marshal / JS-side conversion)
///     loses a value when one ever does.
struct JsClassifyOutputHandler
    : addon_cpp::out_handl::JsBaseOutputHandler<ClassifyOutput> {
  JsClassifyOutputHandler()
      : JsBaseOutputHandler<ClassifyOutput>(
            [this](const ClassifyOutput& cppOut) -> js_value_t* {
              auto array = jsu::Array::create(this->env_);
              const bool trace = []() {
                const char* v = std::getenv("QVAC_CLASSIFICATION_TRACE");
                return v != nullptr && v[0] == '1';
              }();
              for (size_t i = 0; i < cppOut.results.size(); ++i) {
                // Read into named locals BEFORE creating any JS values.
                const std::string& labelString = cppOut.results[i].label;
                const float confidenceFloat = cppOut.results[i].confidence;
                const double confidenceDouble =
                    static_cast<double>(confidenceFloat);

                if (trace) {
                  std::fprintf(
                      stderr,
                      "[qvac-classify-marshal] i=%zu label='%s' "
                      "confidence_float=%.9f confidence_double=%.9f\n",
                      i,
                      labelString.c_str(),
                      static_cast<double>(confidenceFloat),
                      confidenceDouble);
                  std::fflush(stderr);
                }

                auto entry = jsu::Object::create(this->env_);
                entry.setProperty(
                    this->env_,
                    "label",
                    jsu::String::create(this->env_, labelString));
                entry.setProperty(
                    this->env_,
                    "confidence",
                    jsu::Number::create(this->env_, confidenceDouble));
                array.set(this->env_, i, entry);
              }
              return array;
            }) {}
};

inline js_value_t* createInstance(
    js_env_t* env, js_callback_info_t* info) try {
  addon_cpp::JsArgsParser args(env, info);

  auto configObj = args.getJsObject(1, "config");
  auto modelPath =
      configObj.getProperty<jsu::String>(env, "path").as<std::string>(env);

  auto model = std::make_unique<ClassificationModel>(modelPath);

  // Optional threads hint nested under `config`.
  auto innerConfig =
      configObj.getOptionalProperty<jsu::Object>(env, "config");
  if (innerConfig.has_value()) {
    auto threadsOpt =
        innerConfig->getOptionalProperty<jsu::Number>(env, "threads");
    if (threadsOpt.has_value()) {
      model->setNumThreads(threadsOpt->as<int32_t>(env));
    }
  }

  model->load();

  addon_cpp::out_handl::OutputHandlers<addon_cpp::out_handl::JsOutputHandlerInterface>
      outHandlers;
  outHandlers.add(std::make_shared<JsClassifyOutputHandler>());

  auto innerCallback = std::make_unique<addon_cpp::OutputCallBackJs>(
      env, args.get(0, "jsHandle"), args.getFunction(2, "outputCallback"),
      std::move(outHandlers));

  // Wrap the upstream callback in our deferred-destruction adapter so
  // rapid ImageClassifier create/destroy cycles don't hit the
  // use-after-free race in upstream's ~OutputCallBackJs. See the
  // DeferredOutputCallBackJs class comment above for root cause.
  auto callback = std::make_unique<DeferredOutputCallBackJs>(
      env, std::move(innerCallback));

  auto addon = std::make_unique<addon_cpp::AddonJs>(
      env, std::move(callback),
      std::unique_ptr<addon_cpp::model::IModel>(std::move(model)));

  return addon_cpp::JsInterface::createInstance(env, std::move(addon));
}
JSCATCH

inline js_value_t* runJob(js_env_t* env, js_callback_info_t* info) try {
  addon_cpp::JsArgsParser args(env, info);
  addon_cpp::AddonJs& instance =
      addon_cpp::JsInterface::getInstance(env, args.get(0, "instance"));

  // The JS layer delivers a single message of type "image" carrying the
  // image buffer and, optionally, raw-RGB dimension metadata.
  auto inputObj = args.getJsObject(1, "inputObj");
  auto type =
      inputObj.getProperty<jsu::String>(env, "type").as<std::string>(env);
  if (type != "image") {
    throw StatusError(
        InvalidArgument,
        "Classification addon accepts only 'image' input type, got '" + type +
            "'");
  }

  ClassifyInput cppInput;

  // Image buffer: accept Uint8Array / Buffer (stored as TypedArray on the JS
  // side).
  auto bufferVal = inputObj.getProperty(env, "content");
  if (!jsu::is<jsu::TypedArray<uint8_t>>(env, bufferVal)) {
    throw StatusError(
        InvalidArgument,
        "Image 'content' must be a Uint8Array / Buffer of encoded JPEG/PNG "
        "bytes or raw RGB bytes.");
  }
  auto ta = jsu::TypedArray<uint8_t>(env, bufferVal);
  auto span = ta.as<std::span<const uint8_t>>(env);
  if (span.empty()) {
    throw StatusError(InvalidArgument, "Image 'content' buffer is empty");
  }
  cppInput.data.assign(span.begin(), span.end());

  // Optional dimension metadata for the raw-RGB path.
  auto widthOpt = inputObj.getOptionalProperty<jsu::Number>(env, "width");
  auto heightOpt = inputObj.getOptionalProperty<jsu::Number>(env, "height");
  auto channelsOpt =
      inputObj.getOptionalProperty<jsu::Number>(env, "channels");
  if (widthOpt.has_value()) {
    cppInput.width = widthOpt->as<uint32_t>(env);
  }
  if (heightOpt.has_value()) {
    cppInput.height = heightOpt->as<uint32_t>(env);
  }
  if (channelsOpt.has_value()) {
    cppInput.channels = channelsOpt->as<uint32_t>(env);
  }

  auto topKOpt = inputObj.getOptionalProperty<jsu::Number>(env, "topK");
  if (topKOpt.has_value()) {
    cppInput.topK = topKOpt->as<uint32_t>(env);
  }

  return instance.runJob(std::any(std::move(cppInput)));
}
JSCATCH

} // namespace qvac_lib_infer_ggml_classification::bindings
