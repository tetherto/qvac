#pragma once

#include <js.h>

#include "../JsUtils.hpp"
#include "../Logger.hpp"
#include "../Utils.hpp"
#include "../handlers/JsOutputHandlerImplementations.hpp"
#include "OutputCallbackInterface.hpp"
#include "OutputQueue.hpp"

namespace qvac_lib_inference_addon_cpp {

class OutputCallBackJs : public OutputCallBackInterface {

  std::mutex mtx_;
  js_env_t* env_;
  js_ref_t* jsHandle_;
  js_ref_t* outputCb_;
  js_threadsafe_function_t* threadsafeOutputCb_;
  std::shared_ptr<OutputQueue> outputQueue_ = nullptr;
  out_handl::OutputHandlers<out_handl::JsOutputHandlerInterface>
      outputHandlers_;
  bool stopped_{false};

public:
  uv_async_t* jsOutputCallbackAsyncHandle_;

  OutputCallBackJs(
      js_env_t* env, js_value_t* jsHandle, js_value_t* outputCb,
      out_handl::OutputHandlers<out_handl::JsOutputHandlerInterface>&&
          outputHandlers)
      : env_(env), outputHandlers_(std::move(outputHandlers)) {
    JS(js_create_reference(env_, jsHandle, 1, &jsHandle_));
    auto e1 = utils::onError([this, env = env_, jsHandle = jsHandle_]() {
      js_delete_reference(env, jsHandle);
    });
    JS(js_create_reference(env_, outputCb, 1, &outputCb_));
    auto e2 = utils::onError([this, env = env_, outputCb = outputCb_]() {
      js_delete_reference(env, outputCb);
    });
    outputHandlers_.add(
        std::make_shared<out_handl::JsRuntimeStatsOutputHandler>());
    outputHandlers_.add(std::make_shared<out_handl::JsLogMsgOutputHandler>());
    outputHandlers_.add(std::make_shared<out_handl::JsErrorOutputHandler>());
  }

  ~OutputCallBackJs() {
    stop();
    // Important: uv_close might not be called outside the loop thread
    uv_close(
        reinterpret_cast<uv_handle_t*>(jsOutputCallbackAsyncHandle_),
        [](uv_handle_t* handle) { delete handle; });
    if (js_delete_reference(env_, jsHandle_) != 0)
      QLOG(logger::Priority::WARNING, "Could not delete jsHandle reference");
    if (js_delete_reference(env_, outputCb_) != 0)
      QLOG(logger::Priority::WARNING, "Could not delete outputCb reference");
  }

  void
  initializeProcessingThread(std::shared_ptr<OutputQueue> outputQueue) final {
    this->outputQueue_ = outputQueue;
    uv_loop_t* jsLoop;
    JS(js_get_env_loop(env_, &jsLoop));
    jsOutputCallbackAsyncHandle_ = new uv_async_t{};
    if (uv_async_init(jsLoop, jsOutputCallbackAsyncHandle_, jsOutputCallback) !=
        0) {
      delete jsOutputCallbackAsyncHandle_;
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InternalError,
          "Could not initialize uv async handle");
    }
    // jsOutputCallbackAsyncHandle_ has been correctly initialized, so if thread
    // fails it needs to be closed
    auto e3 = utils::onError([this]() {
      uv_close(
          reinterpret_cast<uv_handle_t*>(jsOutputCallbackAsyncHandle_),
          [](uv_handle_t* handle) { delete handle; });
    });
    uv_handle_set_data(
        reinterpret_cast<uv_handle_t*>(jsOutputCallbackAsyncHandle_), this);
  }

  void notify() final { uv_async_send(jsOutputCallbackAsyncHandle_); }

  void stop() final { stopped_ = true; }

private:
  js_value_t* createEventName(const QueuedOutputEvent& outputEvent) {
    switch (outputEvent.eventKind) {
    case OutputEventKind::Output:
      return js::String::create(env_, "Output");
    case OutputEventKind::JobEnded:
      return js::String::create(env_, "JobEnded");
    case OutputEventKind::Error:
      return js::String::create(env_, "Error");
    }

    return js::String::create(env_, "Output");
  }

  /**
   * @brief Creates JavaScript parameters for output events using handlers
   * @returns Pair of JavaScript values for output data and error
   */
  std::pair<js_value_t*, js_value_t*>
  createEventParams(const QueuedOutputEvent& outputEvent) {
    if (!outputEvent.payload.has_value()) {
      // e.g. JobStarted events don't have data
      return {js::Undefined::create(env_), js::Undefined::create(env_)};
    }

    out_handl::JsOutputHandlerInterface& handler =
        outputHandlers_.get(outputEvent.payload);
    handler.setEnv(env_);
    js_value_t* handlerResult = handler.handleOutput(outputEvent.payload);

    // For Error events, put handler result in error parameter (second)
    // For other events, put handler result in output parameter (first)
    if (outputEvent.eventKind == OutputEventKind::Error) {
      return {js::Undefined::create(env_), handlerResult};
    } else {
      return {handlerResult, js::Undefined::create(env_)};
    }
  }

  /**
   * @brief Creates the parameters for the output callback function:
   *   outputCbParameters[0] = JS handle
   *   outputCbParameters[1] = Event string
   *   outputCbParameters[2] = Output data
   *   outputCbParameters[3] = Error data
   *   outputCbParameters[4] = Native job ID
   */
  void createOutputCbParams(
      js_value_t* jsHandle, const QueuedOutputEvent& outputEvent,
      js_value_t** outputCbParameters) {
    outputCbParameters[0] = jsHandle;
    outputCbParameters[1] = createEventName(outputEvent);

    std::tie(outputCbParameters[2], outputCbParameters[3]) =
        createEventParams(outputEvent);
    outputCbParameters[4] =
        js::Number::create(env_, static_cast<double>(outputEvent.jobId));
  }

  /**
   * @brief Static callback function called from JavaScript event loop to
   * process output queue
   * @param handle UV async handle containing addon instance data
   */
  static void jsOutputCallback(uv_async_t* handle) try {
    auto& outputCallBackJs = *reinterpret_cast<OutputCallBackJs*>(
        uv_handle_get_data(reinterpret_cast<uv_handle_t*>(handle)));
    js_handle_scope_t* scope;
    JS(js_open_handle_scope(outputCallBackJs.env_, &scope));
    auto scopeCleanup = utils::onExit([env = outputCallBackJs.env_, scope]() {
      js_close_handle_scope(env, scope);
    });
    js_value_t* outputCb;
    JS(js_get_reference_value(
        outputCallBackJs.env_, outputCallBackJs.outputCb_, &outputCb));
    js_value_t* jsHandle;
    JS(js_get_reference_value(
        outputCallBackJs.env_, outputCallBackJs.jsHandle_, &jsHandle));
    std::vector<QueuedOutputEvent> outputQueue;
    {
      std::scoped_lock lk{outputCallBackJs.mtx_};
      outputQueue = std::move(outputCallBackJs.outputQueue_->clear());
    }
    for (size_t i = 0; !outputCallBackJs.stopped_ && i < outputQueue.size();
         i++) {
      js_handle_scope_t* innerScope;
      JS(js_open_handle_scope(outputCallBackJs.env_, &innerScope));
      auto scopeCleanup =
          utils::onExit([env = outputCallBackJs.env_, innerScope]() {
            js_close_handle_scope(env, innerScope);
          });
      static constexpr auto outputCbParametersCount = 5;
      js_value_t* outputCbParameters[outputCbParametersCount];
      outputCallBackJs.createOutputCbParams(
          jsHandle, outputQueue[i], outputCbParameters);
      js_value_t* receiver;
      JS(js_get_global(outputCallBackJs.env_, &receiver));
      JS(js_call_function(
          outputCallBackJs.env_,
          receiver,
          outputCb,
          utils::arrayCount(outputCbParameters),
          outputCbParameters,
          nullptr));
    }
  } catch (...) {
    auto& outputCallBackJs = *reinterpret_cast<OutputCallBackJs*>(
        uv_handle_get_data(reinterpret_cast<uv_handle_t*>(handle)));
    js_handle_scope_t* scope;
    if (js_open_handle_scope(outputCallBackJs.env_, &scope) != 0)
      return;
    auto scopeCleanup = utils::onExit([env = outputCallBackJs.env_, scope]() {
      js_close_handle_scope(env, scope);
    });
    bool isExceptionPending;
    if (js_is_exception_pending(outputCallBackJs.env_, &isExceptionPending) !=
        0)
      return;
    if (isExceptionPending) {
      js_value_t* error;
      js_get_and_clear_last_exception(outputCallBackJs.env_, &error);
    }
    QLOG(logger::Priority::ERROR, "jsOutputCallback: failed");
  }
};
} // namespace qvac_lib_inference_addon_cpp
