#pragma once

#include <mutex>
#include <unordered_map>

#include <qvac-lib-inference-addon-cpp/FinetuningParameters.hpp>

namespace qvac_lib_inference_addon_llama_detail {

void put(
    void* key,
    const qvac_lib_inference_addon_cpp::FinetuningParameters& params);

bool take(
    void* key,
    qvac_lib_inference_addon_cpp::FinetuningParameters& outParams);

void erase(void* key);

}
