#pragma once

#include "qvac-lib-inference-addon-cpp/Addon.hpp"
#include "qvac-lib-inference-addon-cpp/RuntimeStats.hpp"
#include "src/model-interface/TTSModel.hpp"
#include <vector>
#include <cstring>

namespace qvac_lib_inference_addon_tts {

using Addon = qvac_lib_inference_addon_cpp::Addon<qvac::ttslib::addon_model::TTSModel>;

}

namespace qvac_lib_inference_addon_cpp {

template <>
void qvac_lib_inference_addon_tts::Addon::loadWeights(js_env_t* env, js_value_t* weightsData);

template <> 
void qvac_lib_inference_addon_tts::Addon::processSignalUnloadWeights(std::string &input);

template <> 
void qvac_lib_inference_addon_tts::Addon::processSignalFinetune(std::string &input);

template <> 
std::string qvac_lib_inference_addon_tts::Addon::getNextPiece(std::string &input, size_t lastPieceEnd);

namespace output_handler {

template <>
js_value_t* createOutputData<std::vector<int16_t>>(js_env_t* env, const std::vector<int16_t>& data);

}

}
