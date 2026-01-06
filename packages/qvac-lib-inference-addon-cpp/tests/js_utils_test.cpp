#include "qvac-lib-inference-addon-cpp/JsUtils.hpp"
#include "helpers_header/js.h"
#include <gtest/gtest.h>
#include <utility>

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

TEST(JsUtilsTest, UniqueJsRefConstructorWithDeleter) {
    js_value_t jsValue;
    js::ImmediateUniqueRefDeleter deleter;
    js_env_t env;
    js::UniqueJsRef<js::Object> ref(&env, &jsValue, &deleter);
    // Test passes if no exception is thrown
}

} // namespace qvac_lib_inference_addon_cpp::js_utils
