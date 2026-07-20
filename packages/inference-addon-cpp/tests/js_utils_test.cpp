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

} // namespace qvac_lib_inference_addon_cpp::js_utils
