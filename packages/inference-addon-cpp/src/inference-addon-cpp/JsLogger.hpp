#pragma once

#include "Logger.hpp"
#include "JsUtils.hpp"
#include "Utils.hpp"
#include <inference-addon-cpp/Errors.hpp>
#include <uv.h>

#include <atomic>
#include <deque>
#include <iostream>
#include <memory>
#include <mutex>

namespace utils = qvac_lib_inference_addon_cpp::utils;

namespace qvac_lib_inference_addon_cpp::logger {
  class JsLogger {
  public:
    JsLogger() = delete;

    struct State {
      js_env_t *env;
      js_ref_t *cb;
    };

    struct LogEntry {
      int priority;
      std::string message;
    };

    static auto setLogger(js_env_t *env, js_callback_info_t *info) -> js_value_t* try {
      auto args = js::getArguments(env, info);
      if (args.size() != 1) {
        throw qvac_errors::StatusError(qvac_errors::general_error::InvalidArgument, "Expected 1 argument: logging callback");
      }
      js_value_t *fn = args[0];
      if (!js::is<js::Function>(env, fn)) {
        throw qvac_errors::StatusError(qvac_errors::general_error::InvalidArgument, "Argument must be a function");
      }

      // Serialize install/release/teardown so state_, async_initiated_ and
      // logger_async_ are always mutated as one consistent unit.
      const std::lock_guard<std::mutex> admin(admin_mutex_);

      auto cur = loadState();
      if (cur && cur->env != env) {
        // This singleton supports a single live owning env at a time.
        // A different env still owns the logger. In the supported model the
        // previous owner clears state_ (via releaseLogger or onEnvTeardown)
        // before the next env installs, so a populated different-env slot means
        // a genuinely concurrent live env (unsupported) or an install racing an
        // in-progress teardown. We cannot touch the other env's ref / handle /
        // loop safely, so reject and leave the incumbent fully intact.
        throw qvac_errors::StatusError(
            qvac_errors::general_error::InvalidArgument,
            "Logger already installed by another env; call releaseLogger "
            "first");
      }

      js_ref_t *newCb = nullptr;
      JS(js_create_reference(env, fn, 1, &newCb));
      auto onErrorDeleteRef = utils::onError([&](){ js_delete_reference(env, newCb); });

      // async_initiated_ / logger_async_ are only ever read or written under
      // admin_mutex_ (held above), so a plain bool is sufficient here.
      if (!async_initiated_) {
        // First install (or a clean reinstall after teardown/release): create
        // the async handle on THIS env's loop.
        async_initiated_ = true;
        uv_loop_t* jsLoop = nullptr;
        JS(js_get_env_loop(env, &jsLoop));
        logger_async_ = new uv_async_t{};
        if (uv_async_init(jsLoop, logger_async_, &JsLogger::asyncCallback) != 0) {
          delete logger_async_;
          logger_async_ = nullptr;
          async_initiated_ = false;
          throw qvac_errors::StatusError(qvac_errors::general_error::InternalError, "Could not initialize uv async handle.");
        }
        // Handle initialized; if the steps below throw it must be closed again.
        auto onErrorClose = utils::onError([&]() { closeAsyncHandleLocked(); });

        // Tie cleanup to THIS env's lifetime. If the runtime tears this env
        // down without releaseLogger() being called first (e.g. a
        // worker/runtime teardown), onEnvTeardown fires while the env is being
        // destroyed but BEFORE its JS context is disposed, disarming the logger
        // so the teardown's final uv_run cannot dispatch asyncCallback against
        // a dead context. The env is passed as the callback data so a stale
        // hook can only ever disarm its own env, never a newer owner.
        JS(js_add_teardown_callback(env, &JsLogger::onEnvTeardown, env));
      }

      auto oldState = storeState(std::make_shared<State>(State{env, newCb}));
      if (oldState) {
        // Only reachable when oldState->env == env (a different env was
        // rejected above), i.e. this same live env is replacing its own
        // callback, so freeing the previous ref here is safe.
        releaseJsRefs(oldState->env, oldState->cb);
      }

      return nullptr;
    } JSCATCH

    static auto releaseLogger(js_env_t *env, js_callback_info_t * /*info*/) -> js_value_t* try {
      const std::lock_guard<std::mutex> admin(admin_mutex_);

      auto cur = loadState();
      if (!cur || cur->env != env) {
        // Not the owner (or nobody owns it): never tear down another env's
        // logger. Symmetric with setLogger's reject.
        return nullptr;
      }

      storeState(nullptr);
      // Owner is live and releasing explicitly, so drop its hook + ref, then
      // close the handle (on this env's own loop) and clear any queued entries.
      dropOwnerLocked(cur, /*removeHook=*/true, /*deleteRef=*/true);
      closeAsyncHandleLocked();
      clearQueueLocked();
      return nullptr;
    } JSCATCH

    // Called by C++ code to log a message asynchronously. The default log level on the JS side is INFO.
    static void log(const std::string &message) {
      log(qvac_lib_inference_addon_cpp::logger::Priority::INFO, message);
    }

    // Called by C++ code to log a message asynchronously
    static void log(qvac_lib_inference_addon_cpp::logger::Priority level, const std::string &message) {
      log(static_cast<int>(level), message);
    }

  private:
    // Called on the JS thread when uv_async_send fires
    // Note: the `uv_async_t* handle` parameter is provided by libuv but is unused here
    // because we rely on static members for state. If you want per-instance data,
    // you can set `handle->data` and retrieve it here instead of using statics.
    static void asyncCallback(uv_async_t * /*handle*/) {
      auto state = loadState();
      if (!state) { return; }

      js_env_t *env = state->env;
      js_ref_t *cbRef = state->cb;
      if (!env || !cbRef) { return; }

      js_handle_scope_t *scope;
      JS(js_open_handle_scope(env, &scope));
      auto guard = utils::onExit([env, scope]() { js_close_handle_scope(env, scope); });

      // Drain queue
      std::deque<LogEntry> batch; {
        std::lock_guard<std::mutex> lk(queue_mutex_);
        batch.swap(log_queue_);
      }

      js_value_t *cbFn;
      JS(js_get_reference_value(env, cbRef, &cbFn));
      js_value_t *receiver;
      JS(js_get_global(env, &receiver));

      for (auto &logEntry: batch)
        try {
          js_handle_scope_t *innerScope;
          JS(js_open_handle_scope(env, &innerScope));
          auto scopeCleanup = utils::onExit([env, innerScope]() { js_close_handle_scope(env, innerScope); });
          js_value_t *pri;
          js_value_t *msg;
          pri = js::Number::create(env, logEntry.priority);
          JS(js_create_string_utf8(env,
            reinterpret_cast<const utf8_t*>(logEntry.message.data()),
            logEntry.message.size(),
            &msg));
          js_value_t *args[] = {pri, msg};
          js_value_t *result;
          JS(js_call_function(env, receiver, cbFn, 2, args, &result));
        } catch (const std::exception &e) {
          std::cerr << "ERROR: Caught std::exception: " << e.what() << '\n';
        }
        catch (...) {
          std::cerr << "ERROR: Caught unknown exception\n";
        }
    }

    // Invoked by the runtime while this env is being torn down, BEFORE its JS
    // context is disposed. Disarms the logger so a pending uv_async_send that
    // the teardown's final uv_run would otherwise drain cannot dispatch
    // asyncCallback against a dead context: nulling the shared state makes any
    // such callback early-return, and closing the handle stops it firing at all.
    static void onEnvTeardown(void* data) {
      auto* teardownEnv = static_cast<js_env_t*>(data);

      const std::lock_guard<std::mutex> admin(admin_mutex_);

      auto cur = loadState();
      if (!cur || cur->env != teardownEnv) {
        // A different env owns the logger now; this stale hook must not disarm
        // it.
        return;
      }

      storeState(nullptr);
      // The env is being destroyed: do NOT delete the callback ref (its V8
      // handles are already gone) and do NOT remove the hook (it dies with the
      // env). Just disarm the handle and drop any queued entries.
      closeAsyncHandleLocked();
      clearQueueLocked();
    }

    static void log(int priority, const std::string &message) {
      // Gate the enqueue on liveness under admin_mutex_ so an entry can only
      // ever land in the queue while a live owner exists. release/teardown
      // clear the queue under the same lock, so any enqueue is strictly either
      // before a release (then cleared/dropped) or after the next setLogger
      // (then it belongs to the new owner) - a producer can never leave an
      // orphaned entry in the gap that bleeds into the next owner's callback.
      // This also serializes the uv_async_send against install/release/teardown
      // so a producer cannot send a handle that closeAsyncHandleLocked() is
      // closing, and guards the plain-bool async_initiated_.
      const std::lock_guard<std::mutex> admin(admin_mutex_);

      auto state = loadState();
      if (!state) {
        // No live owner (e.g. between releaseLogger/teardown and the next
        // setLogger): drop the message instead of enqueuing an orphan.
        return;
      }

      if (!async_initiated_) {
        throw qvac_errors::StatusError(
            qvac_errors::general_error::InvalidArgument,
            "The logger should be initialized (async)");
      }

      {
        std::lock_guard<std::mutex> guard(queue_mutex_);
        log_queue_.emplace_back(LogEntry{priority, message});
      }
      uv_async_send(logger_async_);
    }

    static void releaseJsRefs(js_env_t *env, js_ref_t *cb) {
      JS(js_delete_reference(env, cb));
    }

    // Requires admin_mutex_ held. Closes and frees the uv_async handle if
    // armed.
    static void closeAsyncHandleLocked() {
      if (async_initiated_) {
        async_initiated_ = false;
        uv_close(
            reinterpret_cast<uv_handle_t*>(logger_async_),
            [](uv_handle_t* handle) { delete handle; });
        logger_async_ = nullptr;
      }
    }

    // Requires admin_mutex_ held and that `state` is the current owner.
    // Detaches the owner: optionally removes its teardown hook and deletes its
    // callback ref. deleteRef must only be requested when the owning env is
    // still live (deleting a torn-down env's ref crashes in
    // GlobalHandles::Release).
    static void dropOwnerLocked(
        const std::shared_ptr<State>& state, bool removeHook, bool deleteRef) {
      if (removeHook) {
        js_remove_teardown_callback(
            state->env, &JsLogger::onEnvTeardown, state->env);
      }
      if (deleteRef) {
        releaseJsRefs(state->env, state->cb);
      }
    }

    // Requires admin_mutex_ held. Drops any queued-but-undrained entries so
    // they cannot bleed into the next owner's callback.
    static void clearQueueLocked() {
      const std::lock_guard<std::mutex> lk(queue_mutex_);
      log_queue_.clear();
    }

    static std::shared_ptr<State> loadState() {
      return std::atomic_load_explicit(&state_, std::memory_order_acquire);
    }

    static std::shared_ptr<State> storeState(std::shared_ptr<State> newState) {
      return std::atomic_exchange_explicit(
          &state_,
          std::move(newState),
          std::memory_order_acq_rel
      );
    }

    // Guarded by admin_mutex_ (all reads/writes happen inside a critical
    // section).
    inline static bool async_initiated_{false};
    inline static uv_async_t* logger_async_{nullptr};
    inline static std::deque<LogEntry> log_queue_{};
    inline static std::mutex queue_mutex_{};
    // Serializes setLogger / releaseLogger / onEnvTeardown critical sections.
    inline static std::mutex admin_mutex_{};
    inline static std::shared_ptr<struct State> state_{
        nullptr}; // Use only safe methods loadState/storeState (it's atomic) !
  };
} //namespace qvac_lib_inference_addon_cpp::logger
