#pragma once

#include <js.h>

namespace qvac_lib_inference_addon_mlc_marian {

js_value_t* createInstance(js_env_t* env, js_callback_info_t* info);
js_value_t* unload(js_env_t* env, js_callback_info_t* info);
js_value_t* load(js_env_t* env, js_callback_info_t* info);
js_value_t* reload(js_env_t* env, js_callback_info_t* info);
js_value_t* loadWeights(js_env_t* env, js_callback_info_t* info);
js_value_t* unloadWeights(js_env_t* env, js_callback_info_t* info);
js_value_t* activate(js_env_t* env, js_callback_info_t* info);
js_value_t* append(js_env_t* env, js_callback_info_t* info);
js_value_t* status(js_env_t* env, js_callback_info_t* info);
js_value_t* pause(js_env_t* env, js_callback_info_t* info);
js_value_t* stop(js_env_t* env, js_callback_info_t* info);
js_value_t* cancel(js_env_t* env, js_callback_info_t* info);
js_value_t* destroyInstance(js_env_t* env, js_callback_info_t* info);
js_value_t* setLogger(js_env_t* env, js_callback_info_t* info);
js_value_t* releaseLogger(js_env_t* env, js_callback_info_t* info);
js_value_t* processBatch(js_env_t* env, js_callback_info_t* info);
}
