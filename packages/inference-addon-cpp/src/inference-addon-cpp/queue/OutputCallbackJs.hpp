#pragma once

#include <atomic>
#include <js.h>
#include <mutex>
#include <utility>
#include <vector>

#include "../JsUtils.hpp"
#include "../Logger.hpp"
#include "../Utils.hpp"
#include "../handlers/JsOutputHandlerImplementations.hpp"
#include "OutputCallbackInterface.hpp"
#include "OutputQueue.hpp"

namespace qvac_lib_inference_addon_cpp {

class OutputCallBackJs : public OutputCallBackInterface {

  struct State {
    std::mutex mtx;
    js_env_t* env;
    js_ref_t* jsHandle;
    js_ref_t* outputCb;
    uv_async_t* asyncHandle = nullptr;
    std::shared_ptr<OutputQueue> outputQueue = nullptr;
    out_handl::OutputHandlers<out_handl::JsOutputHandlerInterface>
        outputHandlers;
    std::atomic_bool stopped{false};

    State(
        js_env_t* env, js_ref_t* jsHandle, js_ref_t* outputCb,
        out_handl::OutputHandlers<out_handl::JsOutputHandlerInterface>&&
            outputHandlers)
        : env(env), jsHandle(jsHandle), outputCb(outputCb),
          outputHandlers(std::move(outputHandlers)) {}
  };

  State* state_;

public:
  uv_async_t* jsOutputCallbackAsyncHandle_;

  OutputCallBackJs(
      js_env_t* env, js_value_t* jsHandle, js_value_t* outputCb,
      out_handl::OutputHandlers<out_handl::JsOutputHandlerInterface>&&
          outputHandlers) {
    js_ref_t* jsHandleRef;
    JS(js_create_reference(env, jsHandle, 1, &jsHandleRef));
    auto e1 = utils::onError([env, jsHandleRef]() {
      js_delete_reference(env, jsHandleRef);
    });
    js_ref_t* outputCbRef;
    JS(js_create_reference(env, outputCb, 1, &outputCbRef));
    auto e2 = utils::onError([env, outputCbRef]() {
      js_delete_reference(env, outputCbRef);
    });
    outputHandlers.add(
        std::make_shared<out_handl::JsRuntimeStatsOutputHandler>());
    outputHandlers.add(std::make_shared<out_handl::JsLogMsgOutputHandler>());
    outputHandlers.add(std::make_shared<out_handl::JsErrorOutputHandler>());
    state_ = new State(
        env, jsHandleRef, outputCbRef, std::move(outputHandlers));
    jsOutputCallbackAsyncHandle_ = nullptr;
  }

  ~OutputCallBackJs() {
    stop();
    if (state_ == nullptr) {
      return;
    }

    State* state = std::exchange(state_, nullptr);
    if (state->asyncHandle != nullptr) {
      uv_close(
          reinterpret_cast<uv_handle_t*>(state->asyncHandle),
          [](uv_handle_t* handle) {
            auto* state = static_cast<State*>(uv_handle_get_data(handle));
            deleteJsReferences(state);
            delete reinterpret_cast<uv_async_t*>(handle);
            delete state;
          });
      return;
    }

    deleteJsReferences(state);
    delete state;
  }

  static void deleteJsReferences(State* state) {
    if (js_delete_reference(state->env, state->jsHandle) != 0)
      QLOG(logger::Priority::WARNING, "Could not delete jsHandle reference");
    if (js_delete_reference(state->env, state->outputCb) != 0)
      QLOG(logger::Priority::WARNING, "Could not delete outputCb reference");
  }

  void
  initializeProcessingThread(std::shared_ptr<OutputQueue> outputQueue) final {
    state_->outputQueue = outputQueue;
    uv_loop_t* jsLoop;
    JS(js_get_env_loop(state_->env, &jsLoop));
    state_->asyncHandle = new uv_async_t{};
    jsOutputCallbackAsyncHandle_ = state_->asyncHandle;
    if (uv_async_init(jsLoop, state_->asyncHandle, jsOutputCallback) != 0) {
      delete state_->asyncHandle;
      state_->asyncHandle = nullptr;
      jsOutputCallbackAsyncHandle_ = nullptr;
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InternalError,
          "Could not initialize uv async handle");
    }
    // jsOutputCallbackAsyncHandle_ has been correctly initialized, so if thread
    // fails it needs to be closed
    auto e3 = utils::onError([this]() {
      uv_close(
          reinterpret_cast<uv_handle_t*>(state_->asyncHandle),
          [](uv_handle_t* handle) { delete handle; });
    });
    uv_handle_set_data(
        reinterpret_cast<uv_handle_t*>(state_->asyncHandle), state_);
  }

  void notify() final {
    if (state_ != nullptr && !state_->stopped.load() &&
        state_->asyncHandle != nullptr) {
      uv_async_send(state_->asyncHandle);
    }
  }

  void stop() final {
    if (state_ != nullptr) {
      state_->stopped = true;
    }
  }

private:
  /**
   * @brief Creates JavaScript parameters for output events using handlers
   * @returns Pair of JavaScript values for output data and error
   */
  static std::pair<js_value_t*, js_value_t*>
  createEventParams(State& state, const std::any& output) {
    if (!output.has_value()) {
      // e.g. JobStarted events don't have data
      return {
          js::Undefined::create(state.env), js::Undefined::create(state.env)};
    }

    out_handl::JsOutputHandlerInterface& handler =
        state.outputHandlers.get(output);
    handler.setEnv(state.env);
    js_value_t* handlerResult = handler.handleOutput(output);

    // For Error events, put handler result in error parameter (second)
    // For other events, put handler result in output parameter (first)
    if (output.type() == typeid(Output::Error)) {
      return {js::Undefined::create(state.env), handlerResult};
    } else {
      return {handlerResult, js::Undefined::create(state.env)};
    }
  }

  /**
   * @brief Creates the parameters for the output callback function:
   *   outputCbParameters[0] = JS handle
   *   outputCbParameters[1] = Event string
   *   outputCbParameters[2] = Output data
   *   outputCbParameters[3] = Error data
   */
  static void createOutputCbParams(
      State& state, js_value_t* jsHandle, const std::any& output,
      js_value_t** outputCbParameters) {
    outputCbParameters[0] = jsHandle;
    outputCbParameters[1] = js::String::create(state.env, output.type().name());

    std::tie(outputCbParameters[2], outputCbParameters[3]) =
        createEventParams(state, output);
  }

  /**
   * @brief Static callback function called from JavaScript event loop to
   * process output queue
   * @param handle UV async handle containing addon instance data
   */
  static void jsOutputCallback(uv_async_t* handle) try {
    auto& state = *reinterpret_cast<State*>(
        uv_handle_get_data(reinterpret_cast<uv_handle_t*>(handle)));
    if (state.stopped.load()) {
      return;
    }
    js_handle_scope_t* scope;
    JS(js_open_handle_scope(state.env, &scope));
    auto scopeCleanup = utils::onExit([env = state.env, scope]() {
      js_close_handle_scope(env, scope);
    });
    js_value_t* outputCb;
    JS(js_get_reference_value(state.env, state.outputCb, &outputCb));
    js_value_t* jsHandle;
    JS(js_get_reference_value(state.env, state.jsHandle, &jsHandle));
    std::vector<std::any> outputQueue;
    {
      std::scoped_lock lk{state.mtx};
      outputQueue = std::move(state.outputQueue->clear());
    }
    for (size_t i = 0; !state.stopped.load() && i < outputQueue.size();
         i++) {
      js_handle_scope_t* innerScope;
      JS(js_open_handle_scope(state.env, &innerScope));
      auto scopeCleanup =
          utils::onExit([env = state.env, innerScope]() {
            js_close_handle_scope(env, innerScope);
          });
      static constexpr auto outputCbParametersCount = 4;
      js_value_t* outputCbParameters[outputCbParametersCount];
      createOutputCbParams(state, jsHandle, outputQueue[i], outputCbParameters);
      js_value_t* receiver;
      JS(js_get_global(state.env, &receiver));
      JS(js_call_function(
          state.env,
          receiver,
          outputCb,
          utils::arrayCount(outputCbParameters),
          outputCbParameters,
          nullptr));
    }
  } catch (...) {
    auto& state = *reinterpret_cast<State*>(
        uv_handle_get_data(reinterpret_cast<uv_handle_t*>(handle)));
    js_handle_scope_t* scope;
    if (js_open_handle_scope(state.env, &scope) != 0)
      return;
    auto scopeCleanup = utils::onExit([env = state.env, scope]() {
      js_close_handle_scope(env, scope);
    });
    bool isExceptionPending;
    if (js_is_exception_pending(state.env, &isExceptionPending) != 0)
      return;
    if (isExceptionPending) {
      js_value_t* error;
      js_get_and_clear_last_exception(state.env, &error);
    }
    QLOG(logger::Priority::ERROR, "jsOutputCallback: failed");
  }
};
} // namespace qvac_lib_inference_addon_cpp
