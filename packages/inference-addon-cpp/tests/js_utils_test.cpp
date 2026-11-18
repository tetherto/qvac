#include "inference-addon-cpp/JsUtils.hpp"
#include "helpers_header/js.h"
#include <gtest/gtest.h>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <deque>
#include <span>
#include <utility>
#include <thread>
#include <chrono>
#include <mutex>
#include <condition_variable>
#include <functional>
#include <memory>
#include <stdexcept>

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

// Pins the libjs 1.32 const placement: a C array of js_value_t* must bind to
// js::Array::set/create (span<js_value_t* const> → js_value_t *const []).
// The mock js_set_array_elements reports failure, so both calls throw.
TEST(JsUtilsTest, ArraySetElementsFromMutableHandleList) {
    js_env_t env;
    auto jsArray = js::Array::create(&env);
    js_value_t first;
    js_value_t second;
    js_value_t* elements[] = {&first, &second};
    EXPECT_THROW(jsArray.set(&env, elements), qvac_errors::StatusError);
    EXPECT_THROW(
        js::Array::create(&env, std::span<js_value_t* const>{elements}),
        qvac_errors::StatusError);
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

namespace {

js_deferred_t* runAndWaitSettled(const std::function<js_value_t*()>& run) {
  mock_js::lastCreatedDeferred = nullptr;
  js_value_t* promise = run();
  EXPECT_NE(promise, nullptr);
  js_deferred_t* deferred = mock_js::lastCreatedDeferred;
  if (deferred == nullptr) {
    return nullptr;
  }
  for (int i = 0; i != 1000 && !deferred->settled.load(); ++i) {
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  return deferred;
}

js_value_t* toNumber(js_env_t* env, const int& value) {
  return js::Number::create(env, static_cast<double>(value));
}

} // namespace

TEST(JsUtilsTest, JsAsyncTaskResolvesWithMarshalledResult) {
  js_env_t env;

  js_deferred_t* deferred = runAndWaitSettled([&env]() {
    return js::JsAsyncTask::run(&env, []() { return 42; }, toNumber);
  });

  ASSERT_NE(deferred, nullptr);
  ASSERT_TRUE(deferred->settled.load());
  EXPECT_FALSE(deferred->rejected);
  ASSERT_NE(deferred->settlement, nullptr);
  EXPECT_EQ(deferred->settlement->numberValue, 42.0);
}

TEST(JsUtilsTest, JsAsyncTaskRejectsStatusErrorWithItsCode) {
  js_env_t env;
  const qvac_errors::StatusError expected(
      qvac_errors::general_error::InvalidArgument, "bad model");

  js_deferred_t* deferred = runAndWaitSettled([&env, &expected]() {
    return js::JsAsyncTask::run(
        &env, [&expected]() -> int { throw expected; }, toNumber);
  });

  ASSERT_NE(deferred, nullptr);
  ASSERT_TRUE(deferred->settled.load());
  EXPECT_TRUE(deferred->rejected);
  ASSERT_NE(deferred->settlement, nullptr);
  EXPECT_EQ(deferred->settlement->errorCode, expected.codeString());
  EXPECT_EQ(deferred->settlement->errorMessage, "bad model");
}

TEST(JsUtilsTest, JsAsyncTaskRejectsOtherExceptionsAsInternalError) {
  js_env_t env;

  js_deferred_t* deferred = runAndWaitSettled([&env]() {
    return js::JsAsyncTask::run(
        &env, []() { throw std::runtime_error("worker failed"); });
  });

  ASSERT_NE(deferred, nullptr);
  ASSERT_TRUE(deferred->settled.load());
  EXPECT_TRUE(deferred->rejected);
  ASSERT_NE(deferred->settlement, nullptr);
  EXPECT_EQ(deferred->settlement->errorCode, "INTERNAL_ERROR");
  EXPECT_EQ(deferred->settlement->errorMessage, "worker failed");
}

TEST(JsUtilsTest, JsAsyncTaskRejectsWhenMarshalThrows) {
  js_env_t env;

  js_deferred_t* deferred = runAndWaitSettled([&env]() {
    return js::JsAsyncTask::run(
        &env,
        []() { return 1; },
        [](js_env_t*, const int&) -> js_value_t* {
          throw std::runtime_error("cannot marshal");
        });
  });

  ASSERT_NE(deferred, nullptr);
  ASSERT_TRUE(deferred->settled.load());
  EXPECT_TRUE(deferred->rejected);
  ASSERT_NE(deferred->settlement, nullptr);
  EXPECT_EQ(deferred->settlement->errorCode, "INTERNAL_ERROR");
  EXPECT_EQ(deferred->settlement->errorMessage, "cannot marshal");
}

// libjs reports a failed call on an empty JavaScript stack as
// js_uncaught_exception.
static int failAsUncaught() { return -2; }

TEST(JsUtilsTest, JsAsyncTaskRejectsAFailedJsCallInMarshalWithAMessage) {
  js_env_t env;

  js_deferred_t* deferred = runAndWaitSettled([&env]() {
    return js::JsAsyncTask::run(
        &env,
        []() { return 1; },
        [](js_env_t*, const int&) -> js_value_t* {
          JS(failAsUncaught());
          return nullptr;
        });
  });

  ASSERT_NE(deferred, nullptr);
  ASSERT_TRUE(deferred->settled.load());
  EXPECT_TRUE(deferred->rejected);
  ASSERT_NE(deferred->settlement, nullptr);
  EXPECT_EQ(
      deferred->settlement->errorCode,
      qvac_errors::StatusError(qvac_errors::general_error::JSLibraryError, "")
          .codeString());
  EXPECT_EQ(
      deferred->settlement->errorMessage,
      "a JavaScript call failed and its exception was reported as uncaught");
}

// The result can own heavy native state, so like the work it is released on
// the loop before the promise settles.
TEST(JsUtilsTest, JsAsyncTaskReleasesResultBeforeSettlement) {
  js_env_t env;

  std::atomic<bool> resultDestroyed{false};
  std::atomic<bool> settledFirst{false};
  struct Probe {
    std::atomic<bool>* destroyed;
    std::atomic<bool>* settledFirst;
    ~Probe() {
      settledFirst->store(
          mock_js::lastCreatedDeferred != nullptr &&
          mock_js::lastCreatedDeferred->settled.load());
      destroyed->store(true);
    }
  };

  js_deferred_t* deferred =
      runAndWaitSettled([&env, &resultDestroyed, &settledFirst]() {
        return js::JsAsyncTask::run(
            &env,
            [&resultDestroyed, &settledFirst]() {
              return std::shared_ptr<Probe>(
                  new Probe{&resultDestroyed, &settledFirst});
            },
            [](js_env_t* env, const std::shared_ptr<Probe>&) {
              return js::Number::create(env, 1.0);
            });
      });

  ASSERT_NE(deferred, nullptr);
  ASSERT_TRUE(deferred->settled.load());
  EXPECT_FALSE(deferred->rejected);
  EXPECT_TRUE(resultDestroyed.load()) << "the result was never released";
  EXPECT_FALSE(settledFirst.load())
      << "the result was released after the promise settled";
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

TEST(JsUtilsTest, JsAsyncTaskWithResultEnvTeardownDuringBlockedWorker) {
  js_env_t env;

  std::mutex mtx;
  std::condition_variable cv;
  bool release = false;
  std::atomic<bool> marshalled{false};

  mock_js::lastCreatedDeferred = nullptr;
  mock_js::lastDeferredTeardownCb = nullptr;
  mock_js::lastDeferredTeardownData = nullptr;
  mock_js::lastDeferredTeardownHandle = nullptr;

  js_value_t* promise = js::JsAsyncTask::run(
      &env,
      [&mtx, &cv, &release]() {
        std::unique_lock<std::mutex> lock(mtx);
        cv.wait(lock, [&release]() { return release; });
        return 7;
      },
      [&marshalled](js_env_t* env, const int& value) {
        marshalled = true;
        return toNumber(env, value);
      });
  EXPECT_NE(promise, nullptr);

  js_deferred_t* deferred = mock_js::lastCreatedDeferred;
  ASSERT_NE(deferred, nullptr);
  js_deferred_teardown_t* teardown = mock_js::lastDeferredTeardownHandle;
  ASSERT_NE(teardown, nullptr);
  ASSERT_NE(mock_js::lastDeferredTeardownCb, nullptr);

  mock_js::lastDeferredTeardownCb(teardown, mock_js::lastDeferredTeardownData);

  {
    std::lock_guard<std::mutex> lock(mtx);
    release = true;
  }
  cv.notify_one();

  for (int i = 0; i != 1000 && !teardown->finished.load(); ++i) {
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  ASSERT_TRUE(teardown->finished.load())
      << "completion must finish the deferred teardown so env teardown ends";
  EXPECT_FALSE(marshalled.load())
      << "the result may not be marshalled once env teardown has begun";
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

namespace {

/// An IAsyncTaskExecutor the test drives by hand: post() queues, take()
/// removes the oldest task as a worker thread would when it starts it, and
/// the test runs what take() returned. Single-threaded, so with the mocked uv
/// the whole completion chain runs inline on the test thread.
class ManualExecutor final : public IAsyncTaskExecutor {
public:
  std::uint64_t post(std::function<void()> task) noexcept override {
    if (rejectPosts) {
      return 0;
    }
    const std::uint64_t ticket = nextTicket_++;
    queue_.push_back(Queued{ticket, std::move(task)});
    return ticket;
  }

  bool cancel(std::uint64_t ticket) noexcept override {
    ++cancelCalls;
    for (auto it = queue_.begin(); it != queue_.end(); ++it) {
      if (it->ticket == ticket) {
        queue_.erase(it);
        return true;
      }
    }
    return false;
  }

  std::function<void()> take() {
    if (queue_.empty()) {
      ADD_FAILURE() << "no task was posted to the executor";
      return []() {};
    }
    std::function<void()> task = std::move(queue_.front().task);
    queue_.pop_front();
    return task;
  }

  void runNext() { take()(); }

  [[nodiscard]] size_t queued() const { return queue_.size(); }

  bool rejectPosts = false;
  int cancelCalls = 0;

private:
  struct Queued {
    std::uint64_t ticket;
    std::function<void()> task;
  };
  std::deque<Queued> queue_;
  std::uint64_t nextTicket_ = 1;
};

void resetMockJs() {
  mock_js::lastCreatedDeferred = nullptr;
  mock_js::lastDeferredTeardownCb = nullptr;
  mock_js::lastDeferredTeardownData = nullptr;
  mock_js::lastDeferredTeardownHandle = nullptr;
}

/// Destroyed with the work functor that captures it.
struct DestroyProbe {
  std::atomic<bool>* destroyed;
  ~DestroyProbe() { destroyed->store(true); }
};

} // namespace

TEST(JsUtilsTest, JsAsyncTaskRunOnRunsWorkOnTheExecutor) {
  js_env_t env;
  ManualExecutor executor;
  resetMockJs();
  bool ran = false;

  js_value_t* promise = js::JsAsyncTask::runOn(
      &env,
      executor,
      [&ran]() {
        ran = true;
        return 42;
      },
      toNumber);
  EXPECT_NE(promise, nullptr);
  js_deferred_t* deferred = mock_js::lastCreatedDeferred;
  ASSERT_NE(deferred, nullptr);

  ASSERT_EQ(executor.queued(), 1U) << "runOn must post the work, not run it";
  EXPECT_FALSE(ran);
  EXPECT_FALSE(deferred->settled.load());

  executor.runNext();

  EXPECT_TRUE(ran);
  ASSERT_TRUE(deferred->settled.load());
  EXPECT_FALSE(deferred->rejected);
  ASSERT_NE(deferred->settlement, nullptr);
  EXPECT_EQ(deferred->settlement->numberValue, 42.0);
  EXPECT_EQ(executor.cancelCalls, 0)
      << "a task that settles normally is never cancelled";
}

TEST(JsUtilsTest, JsAsyncTaskRunOnWithoutAResultResolves) {
  js_env_t env;
  ManualExecutor executor;
  resetMockJs();
  bool ran = false;

  js::JsAsyncTask::runOn(&env, executor, [&ran]() { ran = true; });
  js_deferred_t* deferred = mock_js::lastCreatedDeferred;
  ASSERT_NE(deferred, nullptr);
  executor.runNext();

  EXPECT_TRUE(ran);
  ASSERT_TRUE(deferred->settled.load());
  EXPECT_FALSE(deferred->rejected);
}

TEST(JsUtilsTest, JsAsyncTaskRunOnRejectsStatusErrorWithItsCode) {
  js_env_t env;
  ManualExecutor executor;
  resetMockJs();
  const qvac_errors::StatusError expected(
      qvac_errors::general_error::InvalidArgument, "bad index");

  js::JsAsyncTask::runOn(
      &env, executor, [&expected]() -> int { throw expected; }, toNumber);
  js_deferred_t* deferred = mock_js::lastCreatedDeferred;
  ASSERT_NE(deferred, nullptr);
  executor.runNext();

  ASSERT_TRUE(deferred->settled.load());
  EXPECT_TRUE(deferred->rejected);
  ASSERT_NE(deferred->settlement, nullptr);
  EXPECT_EQ(deferred->settlement->errorCode, expected.codeString());
  EXPECT_EQ(deferred->settlement->errorMessage, "bad index");
}

// A task still queued when its env is torn down must not keep the dying env
// waiting: an executor that runs long tasks one at a time could otherwise
// hold the env for every task queued ahead of it. The hook cancels the task
// on the executor and runs the close/finish handshake itself.
TEST(JsUtilsTest, JsAsyncTaskRunOnEnvTeardownCancelsAQueuedTask) {
  js_env_t env;
  ManualExecutor executor;
  resetMockJs();
  std::atomic<bool> probeDestroyed{false};
  auto probe = std::make_shared<DestroyProbe>(DestroyProbe{&probeDestroyed});
  bool ran = false;

  js::JsAsyncTask::runOn(&env, executor, [probe, &ran]() { ran = true; });
  probe.reset();
  js_deferred_t* deferred = mock_js::lastCreatedDeferred;
  js_deferred_teardown_t* teardown = mock_js::lastDeferredTeardownHandle;
  ASSERT_NE(deferred, nullptr);
  ASSERT_NE(teardown, nullptr);
  ASSERT_NE(mock_js::lastDeferredTeardownCb, nullptr);
  ASSERT_EQ(executor.queued(), 1U);

  mock_js::lastDeferredTeardownCb(teardown, mock_js::lastDeferredTeardownData);

  EXPECT_EQ(executor.cancelCalls, 1);
  EXPECT_EQ(executor.queued(), 0U) << "the queued task was not cancelled";
  EXPECT_TRUE(teardown->finished.load())
      << "a cancelled task must finish the deferred teardown at once";
  EXPECT_TRUE(probeDestroyed.load()) << "work captures were never destroyed";
  EXPECT_FALSE(ran);
  EXPECT_FALSE(deferred->settled.load())
      << "no promise/JS operation may run once env teardown has begun";
}

// A task that has already started cannot be cancelled: the env waits for it,
// exactly as for a run() task.
TEST(JsUtilsTest, JsAsyncTaskRunOnEnvTeardownWaitsForAStartedTask) {
  js_env_t env;
  ManualExecutor executor;
  resetMockJs();
  bool ran = false;

  js::JsAsyncTask::runOn(
      &env,
      executor,
      [&ran]() {
        ran = true;
        return 7;
      },
      toNumber);
  js_deferred_t* deferred = mock_js::lastCreatedDeferred;
  js_deferred_teardown_t* teardown = mock_js::lastDeferredTeardownHandle;
  ASSERT_NE(deferred, nullptr);
  ASSERT_NE(teardown, nullptr);

  std::function<void()> started = executor.take();
  mock_js::lastDeferredTeardownCb(teardown, mock_js::lastDeferredTeardownData);

  EXPECT_EQ(executor.cancelCalls, 1);
  EXPECT_FALSE(teardown->finished.load())
      << "teardown finished while the started task was still running";

  started();

  EXPECT_TRUE(ran);
  EXPECT_TRUE(teardown->finished.load())
      << "completion must finish the deferred teardown so env teardown ends";
  EXPECT_FALSE(deferred->settled.load())
      << "no promise/JS operation may run once env teardown has begun";
}

// Once the task has run, the executor is no longer needed: JS may destroy it
// as soon as the Promise settles. The close callback that unregisters the
// teardown hook runs later, so an env teardown in between must not call the
// executor.
TEST(JsUtilsTest, JsAsyncTaskRunOnEnvTeardownAfterSettlementLeavesTheExecutor) {
  js_env_t env;
  ManualExecutor executor;
  resetMockJs();
  // Restores immediate close callbacks for later tests even if an ASSERT
  // below returns early.
  struct DeferCloses {
    DeferCloses() { mock_uv::deferClose = true; }
    ~DeferCloses() {
      mock_uv::deferClose = false;
      mock_uv::runPendingCloses();
    }
  } deferCloses;

  js::JsAsyncTask::runOn(&env, executor, []() {});
  js_deferred_t* deferred = mock_js::lastCreatedDeferred;
  js_deferred_teardown_t* teardown = mock_js::lastDeferredTeardownHandle;
  ASSERT_NE(deferred, nullptr);
  ASSERT_NE(teardown, nullptr);
  executor.runNext();
  ASSERT_TRUE(deferred->settled.load());
  ASSERT_FALSE(teardown->finished.load())
      << "the close callback should still be pending";

  mock_js::lastDeferredTeardownCb(teardown, mock_js::lastDeferredTeardownData);
  EXPECT_EQ(executor.cancelCalls, 0)
      << "the teardown hook called the executor after the task had settled";

  mock_uv::runPendingCloses();
  EXPECT_TRUE(teardown->finished.load())
      << "the close callback must finish the deferred teardown";
}

TEST(JsUtilsTest, JsAsyncTaskRunOnThrowsWhenTheExecutorRejectsTheTask) {
  js_env_t env;
  ManualExecutor executor;
  executor.rejectPosts = true;
  resetMockJs();
  std::atomic<bool> probeDestroyed{false};
  auto probe = std::make_shared<DestroyProbe>(DestroyProbe{&probeDestroyed});

  EXPECT_THROW(
      js::JsAsyncTask::runOn(&env, executor, [probe]() {}),
      qvac_errors::StatusError);
  probe.reset();

  js_deferred_teardown_t* teardown = mock_js::lastDeferredTeardownHandle;
  ASSERT_NE(teardown, nullptr);
  EXPECT_TRUE(teardown->finished.load())
      << "a task that never ran must still finish its deferred teardown, or "
         "env teardown blocks forever";
  EXPECT_TRUE(probeDestroyed.load()) << "work captures were never destroyed";
}

} // namespace qvac_lib_inference_addon_cpp::js_utils
