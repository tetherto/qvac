#pragma once

#include "Logger.hpp"
#include "JsUtils.hpp"
#include "Utils.hpp"
#include <qvac-lib-inference-addon-cpp/Errors.hpp>
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

      js_ref_t *newCb = nullptr;
      JS(js_create_reference(env, fn, 1, &newCb));
      auto onErrorDeleteRef = utils::onError([&](){ js_delete_reference(env, newCb); });

      auto newState = std::make_shared<State>(State{env, newCb});

      bool expected = false;
      if (async_initiated_.compare_exchange_strong(expected, true, std::memory_order_acq_rel)) {
        uv_loop_t* jsLoop = nullptr;
        JS(js_get_env_loop(env, &jsLoop));
        logger_async_ = new uv_async_t{};
        if (uv_async_init(jsLoop, logger_async_, &JsLogger::asyncCallback) != 0) {
          delete logger_async_;
          throw qvac_errors::StatusError(qvac_errors::general_error::InternalError, "Could not initialize uv async handle.");
        }
        // jsOutputCallbackAsyncHandle_ has been correctly initialized, so if thread fails it needs to be closed
        auto onErrorClose = utils::onError([&](){
          uv_close(reinterpret_cast<uv_handle_t*>(logger_async_), [](uv_handle_t* handle) {
            delete handle;
          });
        });
      }

      auto oldState = storeState(newState);
      if (oldState) {
        releaseJsRefs((oldState->env), oldState->cb);
      }

      return nullptr;
    } JSCATCH

    static auto releaseLogger(js_env_t *env, js_callback_info_t * /*info*/) -> js_value_t* try {
      auto oldState = storeState(nullptr);
      if (oldState) {
        releaseJsRefs((oldState->env), oldState->cb);
      }
      if (async_initiated_.exchange(false, std::memory_order_acq_rel)) {

        uv_close(reinterpret_cast<uv_handle_t*>(logger_async_), [](uv_handle_t* handle){
          delete handle;
        });
      }
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
          JS(js_create_double(env, logEntry.priority, &pri));
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

    static void log(int priority, const std::string &message) {
      {
        std::lock_guard<std::mutex> guard(queue_mutex_);
        log_queue_.emplace_back(LogEntry{priority, message});
      }
      if (async_initiated_.load(std::memory_order_acquire)) {
        uv_async_send(logger_async_);
      } else {
        auto state = loadState();
        if (!state) return;
        throw qvac_errors::StatusError(qvac_errors::general_error::InvalidArgument, "The logger should be initialized (async)");
      }
    }

    static void releaseJsRefs(js_env_t *env, js_ref_t *cb) {
      JS(js_delete_reference(env, cb));
      env = nullptr;
      cb = nullptr;
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

    static bool compareExchangeState(std::shared_ptr<State>& expected,
                              std::shared_ptr<State> desired) {
      return std::atomic_compare_exchange_strong(&state_, &expected, std::move(desired));
    }

    inline static std::atomic<bool> async_initiated_{false};
    inline static uv_async_t* logger_async_{nullptr};
    inline static std::deque<LogEntry> log_queue_{};
    inline static std::mutex queue_mutex_{};
    inline static std::shared_ptr<struct State> state_{nullptr}; //Use only safe methods loadState/storeState/compareExchangeState (it's atomic) !
  };
} //namespace qvac_lib_inference_addon_cpp::logger
