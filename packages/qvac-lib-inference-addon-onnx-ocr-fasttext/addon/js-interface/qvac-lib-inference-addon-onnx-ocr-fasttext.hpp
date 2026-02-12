#pragma once

#include <js.h>

namespace qvac_lib_inference_addon_onnx_ocr_fasttext {

js_value_t* createInstance(js_env_t* env, js_callback_info_t* info);
js_value_t* runJob(js_env_t* env, js_callback_info_t* info);
}
