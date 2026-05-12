#pragma once

// Whisper-local replacement for
// `qvac_lib_inference_addon_cpp::OutputCallBackJs`.
//
// Why this exists
// ---------------
// `addon-cpp` 1.1.6 moved the `js_delete_reference()` calls inside
// `~OutputCallBackJs()` from a synchronous path into the deferred
// `uv_close` close-callback lambda. On hosts that aggressively
// invalidate the worklet `js_env_t*` shortly after `destroyInstance()`
// returns (notably react-native-bare-kit on iOS, where worklet
// teardown does NOT fire `js_add_teardown_callback` hooks), the
// deferred lambda dereferences a freed `js_env_t*` and crashes with
// EXC_BAD_ACCESS / PAC failure.
//
// Of all addons that share `inference-addon-cpp`, only whispercpp
// reliably loses this race: its `WhisperInterface.unload()` flow does
// `await this.cancel()` (which itself spawns its own thread + uv_async
// inside `JsAsyncTask::run`) immediately followed by
// `await this.addon.destroyInstance()`, while a `StreamingProcessor`
// worker thread keeps the `OutputQueue` hot up to the moment of
// teardown. By the time `~OutputCallBackJs` schedules its `uv_close`,
// the libuv loop already has pending close handles and `uv_async_send`
// activations queued, so the close-callback runs late enough to slip
// past worklet env invalidation.
//
// What this class does differently
// --------------------------------
// Restores the pre-1.1.6 ordering: `js_delete_reference()` is called
// SYNCHRONOUSLY in `~WhisperOutputCallBackJs()` while we are provably
// on the JS thread that owns `state_->env` (the destructor only runs
// from a JS-thread invocation of `destroyInstance` -> `~AddonJs` ->
// `~AddonCpp` -> `~OutputCallBackInterface`; the env is alive by
// definition at that point). The `uv_close` close-callback lambda no
// longer touches JS state at all -- it just frees the heap-allocated
// `uv_async_t` and `State`.
//
// Safety vs. an in-flight `jsOutputCallback`
// ------------------------------------------
//   1. `stop()` (called from `~AddonCpp` body before any member is
//      destroyed AND again at the top of this destructor) sets
//      `state->stopped = true` BEFORE we delete refs.
//   2. The JS thread is single-threaded: libuv cannot run a queued
//      `jsOutputCallback` while we are inside this destructor.
//   3. Any `uv_async_send` activation queued earlier will eventually
//      fire `jsOutputCallback`, which short-circuits on
//      `state.stopped == true` before touching the (now deleted) refs.
//   4. `JobRunner` is destroyed before us by `~AddonCpp` member-order
//      teardown, joining the processing thread, so no more
//      `outputQueue_->queueResult()` -> `notify()` -> `uv_async_send`
//      can be issued on this handle from C++ side.
//   5. `StreamingProcessor` is torn down by
//      `cleanupStreamingSession(instance, /*forceful=*/true)` inside
//      `destroyInstanceWithStreaming` BEFORE
//      `JsInterface::destroyInstance` removes the `AddonJs` from the
//      instance vector, so its worker thread is also joined before we
//      get here.
//
// Maintenance note
// ----------------
// This file is structurally a copy of
// `inference-addon-cpp/queue/OutputCallbackJs.hpp` from `addon-cpp
// 1.1.7#1`. Keep the JS handler list (`JsRuntimeStatsOutputHandler`,
// `JsLogMsgOutputHandler`, `JsErrorOutputHandler`) and the
// `jsOutputCallback` body in sync with upstream when bumping
// `qvac-lib-inference-addon-cpp`. The ONLY structural deviation is
// the destructor body and the close-callback lambda; everything else
// must remain behaviourally identical.

#include <atomic>
#include <js.h>
#include <mutex>
#include <utility>
#include <vector>

#include <inference-addon-cpp/JsUtils.hpp>
#include <inference-addon-cpp/Logger.hpp>
#include <inference-addon-cpp/Utils.hpp>
#include <inference-addon-cpp/handlers/JsOutputHandlerImplementations.hpp>
#include <inference-addon-cpp/queue/OutputCallbackInterface.hpp>
#include <inference-addon-cpp/queue/OutputQueue.hpp>

namespace qvac_lib_inference_addon_whisper {

namespace js = qvac_lib_inference_addon_cpp::js;
namespace utils = qvac_lib_inference_addon_cpp::utils;
namespace out_handl = qvac_lib_inference_addon_cpp::out_handl;
namespace logger = qvac_lib_inference_addon_cpp::logger;
using qvac_lib_inference_addon_cpp::OutputCallBackInterface;
using qvac_lib_inference_addon_cpp::OutputQueue;
namespace Output = qvac_lib_inference_addon_cpp::Output;

class WhisperOutputCallBackJs : public OutputCallBackInterface {

  struct State {
    std::mutex mtx;
    js_env_t *env;
    js_ref_t *jsHandle;
    js_ref_t *outputCb;
    uv_async_t *asyncHandle = nullptr;
    std::shared_ptr<OutputQueue> outputQueue = nullptr;
    out_handl::OutputHandlers<out_handl::JsOutputHandlerInterface>
        outputHandlers;
    std::atomic_bool stopped{false};

    State(js_env_t *env, js_ref_t *jsHandle, js_ref_t *outputCb,
          out_handl::OutputHandlers<out_handl::JsOutputHandlerInterface>
              &&outputHandlers)
        : env(env), jsHandle(jsHandle), outputCb(outputCb),
          outputHandlers(std::move(outputHandlers)) {}
  };

  State *state_;

public:
  uv_async_t *jsOutputCallbackAsyncHandle_;

  WhisperOutputCallBackJs(
      js_env_t *env, js_value_t *jsHandle, js_value_t *outputCb,
      out_handl::OutputHandlers<out_handl::JsOutputHandlerInterface>
          &&outputHandlers) {
    js_ref_t *jsHandleRef;
    JS(js_create_reference(env, jsHandle, 1, &jsHandleRef));
    auto e1 = utils::onError(
        [env, jsHandleRef]() { js_delete_reference(env, jsHandleRef); });
    js_ref_t *outputCbRef;
    JS(js_create_reference(env, outputCb, 1, &outputCbRef));
    auto e2 = utils::onError(
        [env, outputCbRef]() { js_delete_reference(env, outputCbRef); });
    outputHandlers.add(
        std::make_shared<out_handl::JsRuntimeStatsOutputHandler>());
    outputHandlers.add(std::make_shared<out_handl::JsLogMsgOutputHandler>());
    outputHandlers.add(std::make_shared<out_handl::JsErrorOutputHandler>());
    state_ =
        new State(env, jsHandleRef, outputCbRef, std::move(outputHandlers));
    jsOutputCallbackAsyncHandle_ = nullptr;
  }

  ~WhisperOutputCallBackJs() {
    stop();
    if (state_ == nullptr) {
      return;
    }

    State *state = std::exchange(state_, nullptr);

    // Synchronously delete the JS references while we are still on the
    // JS thread that owns state->env. See file header for the safety
    // argument; this is the whole reason this class exists.
    deleteJsReferences(state);

    if (state->asyncHandle != nullptr) {
      // The async handle still has to be torn down via uv_close (libuv
      // requires it). State must outlive the handle so any already-
      // queued jsOutputCallback activation can short-circuit on
      // state->stopped before reading freed memory. The close callback
      // does NOT touch JS env: env may already be invalidated by the
      // host (e.g. bare-kit worklet teardown) by the time it fires,
      // and we no longer need it for anything.
      uv_close(reinterpret_cast<uv_handle_t *>(state->asyncHandle),
               [](uv_handle_t *handle) {
                 auto *state = static_cast<State *>(uv_handle_get_data(handle));
                 delete reinterpret_cast<uv_async_t *>(handle);
                 delete state;
               });
      return;
    }

    delete state;
  }

  static void deleteJsReferences(State *state) {
    if (js_delete_reference(state->env, state->jsHandle) != 0)
      QLOG(logger::Priority::WARNING, "Could not delete jsHandle reference");
    if (js_delete_reference(state->env, state->outputCb) != 0)
      QLOG(logger::Priority::WARNING, "Could not delete outputCb reference");
  }

  void
  initializeProcessingThread(std::shared_ptr<OutputQueue> outputQueue) final {
    state_->outputQueue = outputQueue;
    uv_loop_t *jsLoop;
    JS(js_get_env_loop(state_->env, &jsLoop));
    state_->asyncHandle = new uv_async_t{};
    jsOutputCallbackAsyncHandle_ = state_->asyncHandle;
    if (uv_async_init(jsLoop, state_->asyncHandle, jsOutputCallback) != 0) {
      delete state_->asyncHandle;
      state_->asyncHandle = nullptr;
      jsOutputCallbackAsyncHandle_ = nullptr;
      throw qvac_errors::StatusError(qvac_errors::general_error::InternalError,
                                     "Could not initialize uv async handle");
    }
    auto e3 = utils::onError([this]() {
      uv_close(reinterpret_cast<uv_handle_t *>(state_->asyncHandle),
               [](uv_handle_t *handle) { delete handle; });
    });
    uv_handle_set_data(reinterpret_cast<uv_handle_t *>(state_->asyncHandle),
                       state_);
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
  static std::pair<js_value_t *, js_value_t *>
  createEventParams(State &state, const std::any &output) {
    if (!output.has_value()) {
      return {js::Undefined::create(state.env),
              js::Undefined::create(state.env)};
    }

    out_handl::JsOutputHandlerInterface &handler =
        state.outputHandlers.get(output);
    handler.setEnv(state.env);
    js_value_t *handlerResult = handler.handleOutput(output);

    if (output.type() == typeid(Output::Error)) {
      return {js::Undefined::create(state.env), handlerResult};
    } else {
      return {handlerResult, js::Undefined::create(state.env)};
    }
  }

  static void createOutputCbParams(State &state, js_value_t *jsHandle,
                                   const std::any &output,
                                   js_value_t **outputCbParameters) {
    outputCbParameters[0] = jsHandle;
    outputCbParameters[1] = js::String::create(state.env, output.type().name());

    std::tie(outputCbParameters[2], outputCbParameters[3]) =
        createEventParams(state, output);
  }

  static void jsOutputCallback(uv_async_t *handle) try {
    auto &state = *reinterpret_cast<State *>(
        uv_handle_get_data(reinterpret_cast<uv_handle_t *>(handle)));
    if (state.stopped.load()) {
      return;
    }
    js_handle_scope_t *scope;
    JS(js_open_handle_scope(state.env, &scope));
    auto scopeCleanup = utils::onExit(
        [env = state.env, scope]() { js_close_handle_scope(env, scope); });
    js_value_t *outputCb;
    JS(js_get_reference_value(state.env, state.outputCb, &outputCb));
    js_value_t *jsHandle;
    JS(js_get_reference_value(state.env, state.jsHandle, &jsHandle));
    std::vector<std::any> outputQueue;
    {
      std::scoped_lock lk{state.mtx};
      outputQueue = std::move(state.outputQueue->clear());
    }
    for (size_t i = 0; !state.stopped.load() && i < outputQueue.size(); i++) {
      js_handle_scope_t *innerScope;
      JS(js_open_handle_scope(state.env, &innerScope));
      auto scopeCleanup = utils::onExit([env = state.env, innerScope]() {
        js_close_handle_scope(env, innerScope);
      });
      static constexpr auto outputCbParametersCount = 4;
      js_value_t *outputCbParameters[outputCbParametersCount];
      createOutputCbParams(state, jsHandle, outputQueue[i], outputCbParameters);
      js_value_t *receiver;
      JS(js_get_global(state.env, &receiver));
      JS(js_call_function(state.env, receiver, outputCb,
                          utils::arrayCount(outputCbParameters),
                          outputCbParameters, nullptr));
    }
  } catch (...) {
    auto &state = *reinterpret_cast<State *>(
        uv_handle_get_data(reinterpret_cast<uv_handle_t *>(handle)));
    js_handle_scope_t *scope;
    if (js_open_handle_scope(state.env, &scope) != 0)
      return;
    auto scopeCleanup = utils::onExit(
        [env = state.env, scope]() { js_close_handle_scope(env, scope); });
    bool isExceptionPending;
    if (js_is_exception_pending(state.env, &isExceptionPending) != 0)
      return;
    if (isExceptionPending) {
      js_value_t *error;
      js_get_and_clear_last_exception(state.env, &error);
    }
    QLOG(logger::Priority::ERROR, "jsOutputCallback: failed");
  }
};

} // namespace qvac_lib_inference_addon_whisper
