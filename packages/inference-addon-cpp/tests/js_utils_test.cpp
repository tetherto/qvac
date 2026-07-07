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

TEST(JsUtilsTest, NumberAsUint64RejectsNegative) {
    js_env_t env;
    auto number = js::Number::create(&env, -1.0);
    EXPECT_THROW(number.as<uint64_t>(&env), qvac_errors::StatusError);
}

TEST(JsUtilsTest, NumberAsUint64RejectsNaN) {
    js_env_t env;
    auto number = js::Number::create(&env, std::nan(""));
    EXPECT_THROW(number.as<uint64_t>(&env), qvac_errors::StatusError);
}

TEST(JsUtilsTest, NumberAsUint64RejectsNonIntegral) {
    js_env_t env;
    auto number = js::Number::create(&env, 1.5);
    EXPECT_THROW(number.as<uint64_t>(&env), qvac_errors::StatusError);
}

TEST(JsUtilsTest, NumberAsUint64RejectsAboveMaxSafeInteger) {
    js_env_t env;
    auto number = js::Number::create(&env, 9007199254740992.0 * 4);
    EXPECT_THROW(number.as<uint64_t>(&env), qvac_errors::StatusError);
}

TEST(JsUtilsTest, NumberAsUint64AcceptsIntegral) {
    js_env_t env;
    auto number = js::Number::create(&env, 42.0);
    EXPECT_EQ(number.as<uint64_t>(&env), 42U);
}

} // namespace qvac_lib_inference_addon_cpp::js_utils
