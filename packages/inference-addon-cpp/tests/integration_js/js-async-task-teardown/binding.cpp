#include <bare.h>
#include <js.h>

#include <atomic>
#include <chrono>
#include <cstdint>
#include <stdexcept>
#include <thread>

#include "inference-addon-cpp/JsUtils.hpp"

namespace js = qvac_lib_inference_addon_cpp::js;

namespace {

/// Gate shared by every env in the process (bare threads load the same addon
/// image), so the main test env can observe and release a JsAsyncTask worker
/// that belongs to a different — possibly already terminated — env.
std::atomic<int32_t> gateStarted{0};
std::atomic<int32_t> gateRelease{0};
std::atomic<int32_t> gateFinished{0};

auto resetGate(js_env_t* /*env*/, js_callback_info_t* /*info*/) -> js_value_t* {
  gateStarted.store(0);
  gateRelease.store(0);
  gateFinished.store(0);
  return nullptr;
}

/// Starts a JsAsyncTask whose worker parks on the gate: it flags started,
/// blocks until releaseGate(), then flags finished. Blocking in C++ (not JS)
/// is the point — env teardown must find the worker genuinely inside work().
auto startGatedTask(js_env_t* env, js_callback_info_t* /*info*/) -> js_value_t* try {
  return js::JsAsyncTask::run(env, []() {
    gateStarted.store(1);
    while (gateRelease.load() == 0) {
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    gateFinished.store(1);
  });
} JSCATCH

/// startGatedTask with a result, which a terminated env must never marshal.
auto startGatedValueTask(js_env_t* env, js_callback_info_t* /*info*/)
    -> js_value_t* try {
  return js::JsAsyncTask::run(
      env,
      []() {
        gateStarted.store(1);
        while (gateRelease.load() == 0) {
          std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
        gateFinished.store(1);
        return int32_t{1};
      },
      [](js_env_t* env, const int32_t& value) {
        return js::Number::create(env, value);
      });
}
JSCATCH

auto releaseGate(js_env_t* /*env*/, js_callback_info_t* /*info*/) -> js_value_t* {
  gateRelease.store(1);
  return nullptr;
}

auto taskStarted(js_env_t* env, js_callback_info_t* /*info*/) -> js_value_t* try {
  return js::Number::create(env, gateStarted.load());
} JSCATCH

auto taskFinished(js_env_t* env, js_callback_info_t* /*info*/) -> js_value_t* try {
  return js::Number::create(env, gateFinished.load());
} JSCATCH

auto startTimedTask(js_env_t* env, js_callback_info_t* info) -> js_value_t* try {
  const auto args = js::getArguments(env, info);
  if (args.size() != 1) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "Expected (durationMs: number)");
  }
  int32_t durationMs = 0;
  JS(js_get_value_int32(env, args[0], &durationMs));

  return js::JsAsyncTask::run(env, [durationMs]() {
    std::this_thread::sleep_for(std::chrono::milliseconds(durationMs));
  });
} JSCATCH

auto startFailingTask(js_env_t* env, js_callback_info_t* /*info*/) -> js_value_t* try {
  return js::JsAsyncTask::run(
      env, []() { throw std::runtime_error("boom from JsAsyncTask worker"); });
} JSCATCH

auto startDoublingTask(js_env_t* env, js_callback_info_t* info)
    -> js_value_t* try {
  const auto args = js::getArguments(env, info);
  if (args.size() != 1) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "Expected (value: number)");
  }
  int32_t value = 0;
  JS(js_get_value_int32(env, args[0], &value));

  return js::JsAsyncTask::run(
      env,
      [value]() {
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
        return value * 2;
      },
      [](js_env_t* env, const int32_t& doubled) {
        return js::Number::create(env, doubled);
      });
}
JSCATCH

auto startFailingValueTask(js_env_t* env, js_callback_info_t* /*info*/)
    -> js_value_t* try {
  return js::JsAsyncTask::run(
      env,
      []() -> int32_t {
        throw qvac_errors::StatusError(
            qvac_errors::general_error::InvalidArgument,
            "bad input for JsAsyncTask worker");
      },
      [](js_env_t* env, const int32_t& value) {
        return js::Number::create(env, value);
      });
}
JSCATCH

/// Calls back into JS while marshalling, so a throw in the callback fails a
/// js_* call inside marshal.
auto startThrowingMarshalTask(js_env_t* env, js_callback_info_t* info)
    -> js_value_t* try {
  const auto args = js::getArguments(env, info);
  if (args.size() != 1) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "Expected (callback: function)");
  }
  js_ref_t* ref;
  JS(js_create_reference(env, args[0], 1, &ref));
  std::shared_ptr<js_ref_t> callback(
      ref, [env](js_ref_t* r) { js_delete_reference(env, r); });

  return js::JsAsyncTask::run(
      env,
      []() { return int32_t{0}; },
      [callback](js_env_t* env, const int32_t&) {
        js_value_t* function;
        JS(js_get_reference_value(env, callback.get(), &function));
        js_value_t* receiver;
        JS(js_get_undefined(env, &receiver));
        js_value_t* result;
        JS(js_call_function(env, receiver, function, 0, nullptr, &result));
        return result;
      });
}
JSCATCH

} // namespace

auto testJsAsyncTaskExports(js_env_t* env, js_value_t* exports) -> js_value_t* {

// NOLINTNEXTLINE(cppcoreguidelines-macro-usage)
#define V(name, fn) \
  { \
    js_value_t *val; \
    if ( js_create_function(env, name, -1, fn, nullptr, &val) != 0) { \
      return nullptr; \
    } \
    if ( js_set_named_property(env, exports, name, val) != 0) { \
      return nullptr; \
    } \
  }

  V("resetGate", resetGate)
  V("startGatedTask", startGatedTask)
  V("startGatedValueTask", startGatedValueTask)
  V("releaseGate", releaseGate)
  V("taskStarted", taskStarted)
  V("taskFinished", taskFinished)
  V("startTimedTask", startTimedTask)
  V("startFailingTask", startFailingTask)
  V("startDoublingTask", startDoublingTask)
  V("startFailingValueTask", startFailingValueTask)
  V("startThrowingMarshalTask", startThrowingMarshalTask)
#undef V

  return exports;
}

// NOLINTNEXTLINE(modernize-use-trailing-return-type)
BARE_MODULE(test_js_async_task_teardown, testJsAsyncTaskExports)
