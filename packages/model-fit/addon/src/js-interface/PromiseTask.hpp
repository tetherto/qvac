#pragma once

#include <exception>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <thread>
#include <utility>

#include <inference-addon-cpp/Errors.hpp>
#include <inference-addon-cpp/JsUtils.hpp>
#include <js.h>
#include <uv.h>

namespace model_fit::bindings {

/// Runs blocking work on a detached thread and settles a Promise on the JS
/// loop with the value `marshal` builds from the result.
///
/// The value-resolving counterpart of `js::JsAsyncTask`, which can only
/// resolve with `undefined`. The teardown handshake is the same: a deferred env
/// teardown keeps the env and its loop alive until the worker has finished, and
/// once teardown has begun the promise is abandoned rather than settled against
/// a dying env.
template <typename Result> class PromiseTask {
  using Work = std::function<Result()>;
  using Marshal = std::function<js_value_t*(js_env_t*, const Result&)>;

  struct State {
    js_env_t* env;
    js_deferred_t* deferred;
    js_deferred_teardown_t* teardown = nullptr;
    /// Loop-thread only: cleared by onEnvTeardown, read by onComplete.
    bool envAlive = true;
    /// Loop-owned; the worker only runs it. Released before settlement so the
    /// captures never outlive a finished teardown.
    Work work;
    Marshal marshal;
    std::optional<Result> result;
    std::exception_ptr error;

    State(js_env_t* e, js_deferred_t* d, Work w, Marshal m)
        : env(e), deferred(d), work(std::move(w)), marshal(std::move(m)) {}
  };

  static void onEnvTeardown(js_deferred_teardown_t*, void* data) {
    static_cast<State*>(data)->envAlive = false;
  }

  static js_value_t* utf8(js_env_t* env, const std::string& text) {
    js_value_t* value;
    JS(js_create_string_utf8(
        env,
        reinterpret_cast<const utf8_t*>(text.c_str()),
        text.size(),
        &value));
    return value;
  }

  /// Same `code`/`message` shape as the error `JSCATCH` throws on the
  /// synchronous path, so a caller can branch on `code` identically whichever
  /// entry point it used.
  static void
  reject(js_env_t* env, js_deferred_t* deferred, std::exception_ptr error) {
    std::string code = "INTERNAL_ERROR";
    std::string message = "Unknown error";
    try {
      std::rethrow_exception(error);
    } catch (const qvac_errors::StatusError& e) {
      code = e.codeString();
      message = e.what();
    } catch (const std::exception& e) {
      message = e.what();
    } catch (...) {
    }
    js_value_t* value;
    JS(js_create_error(env, utf8(env, code), utf8(env, message), &value));
    JS(js_reject_deferred(env, deferred, value));
  }

  /// Loop-side end of every task: fallback release of the work, then the
  /// teardown handshake and the handle itself. Also reached when the worker
  /// never started, where onComplete never runs.
  static void onCloseHandle(uv_handle_t* handle) {
    auto* async = reinterpret_cast<uv_async_t*>(handle);
    std::unique_ptr<State> state(static_cast<State*>(async->data));
    state->work = nullptr;
    state->marshal = nullptr;
    state->result.reset();
    state->error = nullptr;
    // Lets a pending env teardown complete; on a live env it just unregisters.
    js_finish_deferred_teardown_callback(state->teardown);
    delete async;
  }

  static void onComplete(uv_async_t* handle) {
    auto* state = static_cast<State*>(handle->data);
    state->work = nullptr;

    // uv calls this from C, so nothing may throw past it, and the handshake
    // below has to run or env teardown blocks forever: a failed settlement
    // abandons the promise instead.
    if (state->envAlive) {
      js_handle_scope_t* scope = nullptr;
      try {
        JS(js_open_handle_scope(state->env, &scope));
        std::exception_ptr failure = state->error;
        js_value_t* value = nullptr;
        if (!failure) {
          try {
            value = state->marshal(state->env, *state->result);
          } catch (...) {
            failure = std::current_exception();
          }
        }
        if (failure) {
          reject(state->env, state->deferred, failure);
        } else {
          JS(js_resolve_deferred(state->env, state->deferred, value));
        }
      } catch (...) {
      }
      if (scope != nullptr) {
        js_close_handle_scope(state->env, scope);
      }
    }
    state->marshal = nullptr;
    state->result.reset();
    state->error = nullptr;

    uv_close(
        reinterpret_cast<uv_handle_t*>(handle), &PromiseTask::onCloseHandle);
  }

public:
  /// `work` runs on a worker thread; `marshal` runs on the JS loop with its
  /// result. A `work` exception rejects the promise the way `JSCATCH` would
  /// have thrown it.
  static js_value_t* run(js_env_t* env, Work work, Marshal marshal) {
    js_deferred_t* deferred;
    js_value_t* promise;
    JS(js_create_promise(env, &deferred, &promise));

    uv_loop_t* loop;
    JS(js_get_env_loop(env, &loop));
    auto* async = new uv_async_t{};
    if (uv_async_init(loop, async, &PromiseTask::onComplete) != 0) {
      delete async;
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InternalError,
          "model-fit: failed to initialize the async handle");
    }

    auto* state = new State(env, deferred, std::move(work), std::move(marshal));
    async->data = state;

    // Env-scope the task before the worker exists, so env teardown can never
    // race a thread the env does not know about.
    if (js_add_deferred_teardown_callback(
            env, &PromiseTask::onEnvTeardown, state, &state->teardown) != 0) {
      uv_close(reinterpret_cast<uv_handle_t*>(async), [](uv_handle_t* h) {
        auto* a = reinterpret_cast<uv_async_t*>(h);
        delete static_cast<State*>(a->data);
        delete a;
      });
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InternalError,
          "model-fit: failed to register the env teardown callback");
    }

    try {
      std::thread([state, async]() {
        try {
          state->result.emplace(state->work());
        } catch (...) {
          state->error = std::current_exception();
        }
        // Always safe: either the env is alive, or its teardown is blocked on
        // this task's unfinished deferred teardown, keeping the loop running.
        uv_async_send(async);
      }).detach();
    } catch (...) {
      // Nobody will ever send: run the handshake here or the teardown
      // registered above blocks unload forever.
      uv_close(
          reinterpret_cast<uv_handle_t*>(async), &PromiseTask::onCloseHandle);
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InternalError,
          "model-fit: failed to start the fit worker thread");
    }

    return promise;
  }
};

} // namespace model_fit::bindings
