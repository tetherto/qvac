#pragma once

#include <atomic>
#include <condition_variable>
#include <js.h>
#include <memory>
#include <mutex>
#include <thread>
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

  /// Shared-ownership by construction: the teardown handshake ends with the
  /// loop thread's uv close callback and a possibly still-waking off-thread
  /// stop() touching the same mtx/drainedCv, and no flag can order a free
  /// against a waiter that was signalled but not yet scheduled (leaving
  /// wait() re-locks mtx). So each side holds its own ownership share and
  /// whichever finishes last frees the State. create() is the only way to
  /// build one (passkey-guarded constructor), so a State can never exist
  /// outside a shared_ptr and no raw delete can reintroduce the race.
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
    /// Thread owning the env's uv loop; the only thread JS APIs may run on.
    std::thread::id loopThreadId;
    /// Teardown handshake, guarded by mtx: drained flips once the loop-thread
    /// drain has delivered everything, drainPending marks a drain the env
    /// teardown hook committed to run, envAlive flips false when the env
    /// teardown hook fires (JS APIs are illegal from then on).
    std::condition_variable drainedCv;
    bool drained = false;
    bool drainPending = false;
    bool envAlive = true;

  private:
    /// Passkey: private, so only create() can mint the token make_shared
    /// needs. The constructor stays public for make_shared but is
    /// uncallable without a token.
    struct Private {
      explicit Private() = default;
    };

  public:
    State(
        Private, js_env_t* env, js_ref_t* jsHandle, js_ref_t* outputCb,
        out_handl::OutputHandlers<out_handl::JsOutputHandlerInterface>&&
            outputHandlers)
        : env(env), jsHandle(jsHandle), outputCb(outputCb),
          outputHandlers(std::move(outputHandlers)) {}

    static std::shared_ptr<State> create(
        js_env_t* env, js_ref_t* jsHandle, js_ref_t* outputCb,
        out_handl::OutputHandlers<out_handl::JsOutputHandlerInterface>&&
            outputHandlers) {
      return std::make_shared<State>(
          Private{}, env, jsHandle, outputCb, std::move(outputHandlers));
    }
  };

  std::shared_ptr<State> state_;

  /// The uv handle's own ownership share, stored as its handle data; the
  /// close callback deletes it to let go. Heap-allocated because uv carries
  /// only a raw void*.
  using StateOwner = std::shared_ptr<State>;

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
    state_ = State::create(
        env, jsHandleRef, outputCbRef, std::move(outputHandlers));
    jsOutputCallbackAsyncHandle_ = nullptr;
  }

  ~OutputCallBackJs() { stop(); }

  static void deleteJsReferences(State* state) {
    if (js_delete_reference(state->env, state->jsHandle) != 0)
      QLOG(logger::Priority::WARNING, "Could not delete jsHandle reference");
    if (js_delete_reference(state->env, state->outputCb) != 0)
      QLOG(logger::Priority::WARNING, "Could not delete outputCb reference");
  }

  void
  initializeProcessingThread(std::shared_ptr<OutputQueue> outputQueue) final {
    state_->outputQueue = outputQueue;
    state_->loopThreadId = std::this_thread::get_id();
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
    // The handle co-owns the State from here: its share is dropped by
    // whichever close callback runs (error path below, or teardown).
    uv_handle_set_data(
        reinterpret_cast<uv_handle_t*>(state_->asyncHandle),
        new StateOwner(state_));
    // jsOutputCallbackAsyncHandle_ has been correctly initialized, so if
    // anything below fails the handle needs to be closed and forgotten, or
    // stop() would close it a second time.
    auto e3 = utils::onError([this]() {
      uv_close(
          reinterpret_cast<uv_handle_t*>(state_->asyncHandle),
          [](uv_handle_t* handle) {
            delete static_cast<StateOwner*>(uv_handle_get_data(handle));
            delete reinterpret_cast<uv_async_t*>(handle);
          });
      state_->asyncHandle = nullptr;
      jsOutputCallbackAsyncHandle_ = nullptr;
    });
    // If the env tears down (bare-kit unload) while an off-thread stop() is
    // waiting on a drain, the pending uv_async never fires; the hook runs the
    // drain inside the teardown callback instead, while the env is valid.
    JS(js_add_teardown_callback(state_->env, onEnvTeardown, state_.get()));
  }

  void notify() final {
    if (state_ != nullptr && !state_->stopped.load() &&
        state_->asyncHandle != nullptr) {
      uv_async_send(state_->asyncHandle);
    }
  }

  /// Consumes the state: the first call flushes and tears down, later calls
  /// are no-ops. When this returns, every queued event has been delivered
  /// through the JS callback (or the env died and delivery is impossible).
  ///
  /// The local shared_ptr `s` is this call's ownership share. It is declared
  /// before the lock, so on every return the lock releases first and the
  /// State (holding that very mutex) is freed only after this thread is
  /// fully out of the wait — even when the loop thread's close callback has
  /// already dropped the handle's share.
  void stop() final {
    std::shared_ptr<State> s = std::exchange(state_, nullptr);
    if (s == nullptr) {
      return;
    }
    s->stopped = true;
    if (s->asyncHandle == nullptr) {
      // initializeProcessingThread never ran (or failed): construction-time
      // path on the JS thread, nothing queued and no handle to close. `s` is
      // the only share; dropping it frees the State.
      deleteJsReferences(s.get());
      return;
    }
    if (std::this_thread::get_id() == s->loopThreadId) {
      bool envUsable;
      {
        std::scoped_lock lk{s->mtx};
        envUsable = s->envAlive;
      }
      drainAndTeardown(s.get(), envUsable, envUsable);
      return;
    }
    // Off the JS thread — e.g. a cancel JsAsyncTask releasing the last
    // AddonCpp owner after destroyInstance(). JS APIs are illegal here, so
    // ask the loop to drain and block until it has.
    std::unique_lock lk{s->mtx};
    if (s->drained) {
      return; // env teardown hook already flushed
    }
    if (s->drainPending) {
      s->drainedCv.wait(lk, [&s] { return s->drained; });
      return;
    }
    if (!s->envAlive) {
      lk.unlock();
      // The env died before stop() with no drain pending: delivery is
      // impossible and no close callback will ever run, so reclaim the
      // handle's ownership share here and leak only the uv handle itself
      // (its loop died with the env). Dropping `s` then frees the State.
      delete static_cast<StateOwner*>(uv_handle_get_data(
          reinterpret_cast<uv_handle_t*>(s->asyncHandle)));
      return;
    }
    uv_async_send(s->asyncHandle);
    s->drainedCv.wait(lk, [&s] { return s->drained; });
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
   *   outputCbParameters[4] = JobId as JS number, or undefined for kNoJobId (in case of single-job addons)
   */
  static void createOutputCbParams(
      State& state, js_value_t* jsHandle, const std::any& output, JobId id,
      js_value_t** outputCbParameters) {
    outputCbParameters[0] = jsHandle;
    outputCbParameters[1] = js::String::create(state.env, output.type().name());

    std::tie(outputCbParameters[2], outputCbParameters[3]) =
        createEventParams(state, output);

    outputCbParameters[4] = (id == kNoJobId)
        ? js::Undefined::create(state.env)
        : js::Number::create(state.env, id);
  }

  /**
   * @brief Static callback function called from JavaScript event loop to
   * process output queue
   * @param handle UV async handle containing addon instance data
   */
  static void jsOutputCallback(uv_async_t* handle) {
    State* state = static_cast<StateOwner*>(
        uv_handle_get_data(reinterpret_cast<uv_handle_t*>(handle)))->get();
    if (!state->stopped.load()) {
      deliverQueued(*state);
      return;
    }
    // stop() pinged us for the final drain (the handle is closed right after
    // it, so this branch runs at most once).
    bool envUsable;
    {
      std::scoped_lock lk{state->mtx};
      envUsable = state->envAlive;
    }
    drainAndTeardown(state, envUsable, envUsable);
  }

  /// Loop-thread only. Delivers the remaining queue (while @p envUsable),
  /// releases the JS references and the env teardown hook, signals an
  /// off-thread stop() waiting on the drain, and closes the uv handle; the
  /// close callback drops the handle's ownership share, and the State is
  /// freed by whichever owner (that share, or a blocked off-thread stop())
  /// lets go last — never while the other might still be inside the mutex
  /// or condition variable. @p removeHook is false when called from the env
  /// teardown hook itself: the hook is already being consumed and the env
  /// teardown machinery must not be mutated mid-iteration.
  static void drainAndTeardown(State* s, bool envUsable, bool removeHook) {
    if (envUsable) {
      deliverQueued(*s);
      deleteJsReferences(s);
      if (removeHook) {
        js_remove_teardown_callback(s->env, onEnvTeardown, s);
      }
    }
    {
      std::scoped_lock lk{s->mtx};
      s->drained = true;
    }
    s->drainedCv.notify_all();
    uv_close(
        reinterpret_cast<uv_handle_t*>(s->asyncHandle),
        [](uv_handle_t* handle) {
          delete static_cast<StateOwner*>(uv_handle_get_data(handle));
          delete reinterpret_cast<uv_async_t*>(handle);
        });
  }

  /// Env teardown hook (JS thread). Marks the env dead and, when an
  /// off-thread stop() already committed to a drain that the dying loop can
  /// no longer run, performs that drain here — the env is still valid inside
  /// a teardown callback — so the waiter wakes instead of blocking forever.
  /// The raw pointer is safe: the hook is removed before uv_close whenever
  /// the env is usable, so while it can still fire the handle's ownership
  /// share is guaranteed live and keeps the State alive.
  static void onEnvTeardown(void* data) {
    auto* s = static_cast<State*>(data);
    {
      std::scoped_lock lk{s->mtx};
      s->envAlive = false;
      if (!s->stopped.load() || s->drained) {
        return; // instance still live, or already flushed: nothing pending
      }
      s->drainPending = true;
    }
    drainAndTeardown(s, /*envUsable=*/true, /*removeHook=*/false);
  }

  /// Clears (and drops) the env's pending JS exception, if any, so the next
  /// JS call does not observe a stale error state.
  static void clearPendingJsException(js_env_t* env) {
    js_handle_scope_t* scope;
    if (js_open_handle_scope(env, &scope) != 0)
      return;
    auto scopeCleanup =
        utils::onExit([env, scope]() { js_close_handle_scope(env, scope); });
    bool isExceptionPending;
    if (js_is_exception_pending(env, &isExceptionPending) != 0)
      return;
    if (isExceptionPending) {
      js_value_t* error;
      js_get_and_clear_last_exception(env, &error);
    }
  }

  /**
   * @brief Drains the output queue and invokes the JS output callback for
   * each entry. Loop-thread only.
   */
  static void deliverQueued(State& state) try {
    js_handle_scope_t* scope;
    JS(js_open_handle_scope(state.env, &scope));
    auto scopeCleanup = utils::onExit([env = state.env, scope]() {
      js_close_handle_scope(env, scope);
    });
    js_value_t* outputCb;
    JS(js_get_reference_value(state.env, state.outputCb, &outputCb));
    js_value_t* jsHandle;
    JS(js_get_reference_value(state.env, state.jsHandle, &jsHandle));
    std::vector<std::pair<JobId, std::any>> outputQueue;
    {
      std::scoped_lock lk{state.mtx};
      outputQueue = std::move(state.outputQueue->clear());
    }
    for (size_t i = 0; i < outputQueue.size(); i++) {
      // Per-entry isolation: the drained entries are already removed from
      // OutputQueue, so aborting the loop on one entry's failed conversion
      // or throwing JS handler would silently drop the remaining entries —
      // other jobs' outputs and terminal events included. Clear that
      // entry's pending exception and keep delivering.
      try {
        js_handle_scope_t* innerScope;
        JS(js_open_handle_scope(state.env, &innerScope));
        auto scopeCleanup =
            utils::onExit([env = state.env, innerScope]() {
              js_close_handle_scope(env, innerScope);
            });
        static constexpr auto outputCbParametersCount = 5;
        js_value_t* outputCbParameters[outputCbParametersCount];
        createOutputCbParams(
            state, jsHandle, outputQueue[i].second, outputQueue[i].first,
            outputCbParameters);
        js_value_t* receiver;
        JS(js_get_global(state.env, &receiver));
        JS(js_call_function(
            state.env,
            receiver,
            outputCb,
            utils::arrayCount(outputCbParameters),
            outputCbParameters,
            nullptr));
      } catch (...) {
        clearPendingJsException(state.env);
        QLOG(
            logger::Priority::ERROR,
            "jsOutputCallback: delivery failed for one queued entry; "
            "continuing with the rest of the batch");
      }
    }
  } catch (...) {
    clearPendingJsException(state.env);
    QLOG(logger::Priority::ERROR, "jsOutputCallback: failed");
  }
};
} // namespace qvac_lib_inference_addon_cpp
