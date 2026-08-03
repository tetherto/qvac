#include "inference-addon-cpp/JsUtils.hpp"
#include "helpers_header/js.h"
#include <gtest/gtest.h>
#include <cmath>
#include <utility>
#include <thread>
#include <chrono>
#include <mutex>
#include <condition_variable>

namespace qvac_lib_inference_addon_cpp::js_utils {

// This tests that the JsUtils templates compile correctly using a mocked js.h interface

TEST(JsUtilsTest, StringCreate) {
    js_env_t env;
    auto jsString = js::String::create(&env, "test string");
    // Test passes if no exception is thrown
}

TEST(JsUtilsTest, NumberCreate) {
    js_env_t env;
    auto jsNumber = js::Number::create(&env, 42.0);
    // Test passes if no exception is thrown
}

TEST(JsUtilsTest, ArrayCreate) {
    js_env_t env;
    auto jsArray = js::Array::create(&env);
    // Test passes if no exception is thrown
}

TEST(JsUtilsTest, BooleanCreate) {
  js_env_t env;
  auto jsBoolean = js::Boolean::create(&env, true);
  // Test passes if no exception is thrown
}

TEST(JsUtilsTest, JsAsyncTaskRun) {
  js_env_t env;
  // Test that JsAsyncTask::run creates a promise and executes work
  // asynchronously
  std::mutex mtx;
  std::condition_variable cv;
  bool workCompleted = false;

  js_value_t* promise =
      js::JsAsyncTask::run(&env, [&mtx, &cv, &workCompleted]() {
        // Simple work function that signals completion
        {
          std::lock_guard<std::mutex> lock(mtx);
          workCompleted = true;
        }
        cv.notify_one();
      });

  // Test passes if no exception is thrown and promise is returned
  EXPECT_NE(promise, nullptr);

  // Wait for the async task to complete
  std::unique_lock<std::mutex> lock(mtx);
  cv.wait(lock, [&workCompleted]() { return workCompleted; });
  EXPECT_TRUE(workCompleted);
}

TEST(JsUtilsTest, UniqueJsRefConstructorWithDeleter) {
    js_value_t jsValue;
    js::ImmediateUniqueRefDeleter deleter;
    js_env_t env;
    js::UniqueJsRef<js::Object> ref(&env, &jsValue, &deleter);
    // Test passes if no exception is thrown
}

// asChecked<uint64_t> is the validating boundary parse (job ids); the plain
// as<uint64_t> stays a truncating cast, pinned separately below.
TEST(JsUtilsTest, NumberAsCheckedUint64RejectsNegative) {
    js_env_t env;
    auto number = js::Number::create(&env, -1.0);
    EXPECT_THROW(number.asChecked<uint64_t>(&env), qvac_errors::StatusError);
}

TEST(JsUtilsTest, NumberAsCheckedUint64RejectsNaN) {
    js_env_t env;
    auto number = js::Number::create(&env, std::nan(""));
    EXPECT_THROW(number.asChecked<uint64_t>(&env), qvac_errors::StatusError);
}

TEST(JsUtilsTest, NumberAsCheckedUint64RejectsNonIntegral) {
    js_env_t env;
    auto number = js::Number::create(&env, 1.5);
    EXPECT_THROW(number.asChecked<uint64_t>(&env), qvac_errors::StatusError);
}

TEST(JsUtilsTest, NumberAsCheckedUint64RejectsAboveMaxSafeInteger) {
    js_env_t env;
    auto number = js::Number::create(&env, 9007199254740992.0 * 4);
    EXPECT_THROW(number.asChecked<uint64_t>(&env), qvac_errors::StatusError);
}

TEST(JsUtilsTest, NumberAsCheckedUint64AcceptsIntegral) {
    js_env_t env;
    auto number = js::Number::create(&env, 42.0);
    EXPECT_EQ(number.asChecked<uint64_t>(&env), 42U);
}

// The unchecked as<uint64_t> keeps its pre-1.3.0 contract: a plain
// truncating cast, no validation, so downstream addons parsing trusted
// in-range numbers see no behavior change. (Negative/non-finite input is
// undefined per C++ cast rules and deliberately not pinned here.)
TEST(JsUtilsTest, NumberAsUint64TruncatesWithoutValidation) {
    js_env_t env;
    auto number = js::Number::create(&env, 42.9);
    EXPECT_EQ(number.as<uint64_t>(&env), 42U);
}

// JsAsyncTask must be environment-scoped, mirroring OutputCallBackJs: its
// blocking worker — e.g. a cancel waiting for the scheduler to release a
// slot — can outlive the JS environment when a Bare worklet is terminated
// without the promise being awaited. run() must register a deferred env
// teardown callback so a dying env stays alive until the worker finishes,
// completion must skip every promise/JS operation once teardown has begun,
// and the uv close callback must finish the deferred teardown so env
// teardown can complete. Without this, completion opens a handle scope and
// settles the deferred against a destroyed env: a native use-after-free.
TEST(JsUtilsTest, JsAsyncTaskEnvTeardownDuringBlockedWorker) {
  js_env_t env;

  std::mutex mtx;
  std::condition_variable cv;
  bool release = false;

  mock_js::lastCreatedDeferred = nullptr;
  mock_js::lastDeferredTeardownCb = nullptr;
  mock_js::lastDeferredTeardownData = nullptr;
  mock_js::lastDeferredTeardownHandle = nullptr;

  js_value_t* promise =
      js::JsAsyncTask::run(&env, [&mtx, &cv, &release]() {
        std::unique_lock<std::mutex> lock(mtx);
        cv.wait(lock, [&release]() { return release; });
      });
  EXPECT_NE(promise, nullptr);

  // Both recordings happen synchronously inside run() on this thread.
  js_deferred_t* deferred = mock_js::lastCreatedDeferred;
  ASSERT_NE(deferred, nullptr);
  js_deferred_teardown_t* teardown = mock_js::lastDeferredTeardownHandle;
  const bool registered = mock_js::lastDeferredTeardownCb != nullptr;

  // Simulate the env starting teardown while the worker is still blocked.
  if (registered) {
    mock_js::lastDeferredTeardownCb(
        teardown, mock_js::lastDeferredTeardownData);
  }

  // Unblock the worker; the mocked uv_async_send dispatches completion (and
  // the uv close callback) synchronously on the worker thread.
  {
    std::lock_guard<std::mutex> lock(mtx);
    release = true;
  }
  cv.notify_one();

  // Wait for the completion chain to run before asserting, so the detached
  // worker is done with this test's stack whichever way the test ends. With
  // the fix the chain ends by finishing the deferred teardown; without it,
  // the only end-of-chain signal is the (illegal) promise settlement.
  auto chainDone = [&]() {
    return registered ? teardown->finished.load() : deferred->settled.load();
  };
  for (int i = 0; i != 1000 && !chainDone(); ++i) {
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  ASSERT_TRUE(chainDone()) << "async task completion chain never ran";

  ASSERT_TRUE(registered)
      << "JsAsyncTask::run must register a deferred env teardown callback; "
         "without one a terminated env is torn down under the still-running "
         "worker and completion uses freed JS state";
  EXPECT_TRUE(teardown->finished.load())
      << "completion must finish the deferred teardown so env teardown ends";
  EXPECT_FALSE(deferred->settled.load())
      << "no promise/JS operation may run once env teardown has begun";
}

// The work functor commonly captures the last shared_ptr to the addon, and
// its destructors are JS-facing. It must be destroyed on the loop before the
// promise settles: an awaiter may immediately destroy the JS instance, and
// retaining the shared_ptr until the later uv close callback can keep a large
// native model alive through that teardown. It must also die before deferred
// teardown finishes, after which the env can be gone.
TEST(
    JsUtilsTest,
    JsAsyncTaskDestroysWorkCapturesBeforeSettlementAndFinishingTeardown) {
  js_env_t env;

  mock_js::lastCreatedDeferred = nullptr;
  mock_js::lastDeferredTeardownCb = nullptr;
  mock_js::lastDeferredTeardownData = nullptr;
  mock_js::lastDeferredTeardownHandle = nullptr;

  std::atomic<bool> probeDestroyed{false};
  std::atomic<bool> promiseSettledFirst{false};
  std::atomic<bool> teardownFinishedFirst{false};
  struct Probe {
    std::atomic<bool>* destroyed;
    std::atomic<bool>* settledFirst;
    std::atomic<bool>* finishedFirst;
    ~Probe() {
      settledFirst->store(
          mock_js::lastCreatedDeferred != nullptr &&
          mock_js::lastCreatedDeferred->settled.load());
      finishedFirst->store(
          mock_js::lastDeferredTeardownHandle != nullptr &&
          mock_js::lastDeferredTeardownHandle->finished.load());
      destroyed->store(true);
    }
  };
  std::shared_ptr<Probe> probe(
      new Probe{
          &probeDestroyed, &promiseSettledFirst, &teardownFinishedFirst});

  js_value_t* promise = js::JsAsyncTask::run(&env, [probe]() {});
  EXPECT_NE(promise, nullptr);
  // Drop the test's reference: the task owns the last one, so the probe's
  // destructor runs wherever the task destroys the work functor.
  probe.reset();

  for (int i = 0; i != 1000 && !probeDestroyed.load(); ++i) {
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  ASSERT_TRUE(probeDestroyed.load()) << "work captures were never destroyed";
  EXPECT_FALSE(promiseSettledFirst.load())
      << "work captures were retained until after promise settlement: an "
         "awaiter can proceed into teardown while the task still owns heavy "
         "native resources";
  EXPECT_FALSE(teardownFinishedFirst.load())
      << "work captures were destroyed after the deferred teardown finished: "
         "their (JS-facing) destructors ran off-loop against an env that "
         "teardown may already have freed";
}

// A settlement failure inside completion (any JS() call failing) must not
// skip the close/finish handshake: completion runs from a C callback, so a
// throw escaping it terminates the process, and an unfinished deferred
// teardown blocks env teardown (unload) forever.
TEST(JsUtilsTest, JsAsyncTaskSettlementFailureStillFinishesTeardown) {
  js_env_t env;

  mock_js::lastCreatedDeferred = nullptr;
  mock_js::lastDeferredTeardownCb = nullptr;
  mock_js::lastDeferredTeardownData = nullptr;
  mock_js::lastDeferredTeardownHandle = nullptr;
  mock_js::failNextResolveDeferred = true;

  js_value_t* promise = js::JsAsyncTask::run(&env, []() {});
  EXPECT_NE(promise, nullptr);
  js_deferred_teardown_t* teardown = mock_js::lastDeferredTeardownHandle;
  ASSERT_NE(teardown, nullptr);

  for (int i = 0; i != 1000 && !teardown->finished.load(); ++i) {
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  EXPECT_TRUE(teardown->finished.load())
      << "a failed settlement skipped the close/finish handshake; env "
         "teardown would block forever on this task's deferred teardown";
}

} // namespace qvac_lib_inference_addon_cpp::js_utils
