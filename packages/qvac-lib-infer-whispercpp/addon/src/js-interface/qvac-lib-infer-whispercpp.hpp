#pragma once

#include <js.h>

namespace qvac_lib_inference_addon_whisper {

auto createInstance(js_env_t* env, js_callback_info_t* info) -> js_value_t*;
auto unload(js_env_t* env, js_callback_info_t* info) -> js_value_t*;
auto load(js_env_t* env, js_callback_info_t* info) -> js_value_t*;
auto reload(js_env_t* env, js_callback_info_t* info) -> js_value_t*;
auto loadWeights(js_env_t* env, js_callback_info_t* info) -> js_value_t*;
auto unloadWeights(js_env_t* env, js_callback_info_t* info) -> js_value_t*;
auto activate(js_env_t* env, js_callback_info_t* info) -> js_value_t*;
auto append(js_env_t* env, js_callback_info_t* info) -> js_value_t*;
auto status(js_env_t* env, js_callback_info_t* info) -> js_value_t*;
auto pause(js_env_t* env, js_callback_info_t* info) -> js_value_t*;
auto stop(js_env_t* env, js_callback_info_t* info) -> js_value_t*;
auto cancel(js_env_t* env, js_callback_info_t* info) -> js_value_t*;
auto destroyInstance(js_env_t* env, js_callback_info_t* info) -> js_value_t*;

// Logger wrappers
auto setLogger(js_env_t* env, js_callback_info_t* info) -> js_value_t*;
auto releaseLogger(js_env_t* env, js_callback_info_t* info) -> js_value_t*;

} // namespace qvac_lib_inference_addon_whisper
