#pragma once

#include <js.h>

namespace test_logger {

auto setLogger(js_env_t* env, js_callback_info_t* info) -> js_value_t*;
auto cppLog(js_env_t* env, js_callback_info_t* info) -> js_value_t*;
auto dummyCppLogWork(js_env_t* env, js_callback_info_t* info) -> js_value_t*;
auto dummyMultiThreadedCppLogWork(js_env_t* env, js_callback_info_t* info) -> js_value_t*;
auto releaseLogger(js_env_t* env, js_callback_info_t* info) -> js_value_t*;

    //#TODO test0: add my methods from JsInterface

}

