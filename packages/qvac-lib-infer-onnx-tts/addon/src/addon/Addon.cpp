#include "Addon.hpp"
#include "qvac-lib-inference-addon-cpp/Logger.hpp"

namespace qvac_lib_inference_addon_cpp {

template <>
void qvac_lib_inference_addon_tts::Addon::loadWeights(js_env_t* env, js_value_t* weightsData) {
}

template <> 
std::string qvac_lib_inference_addon_tts::Addon::getNextPiece(std::string &input, size_t lastPieceEnd) {
  auto pieceEnd = input.find_first_of(".!?", lastPieceEnd);
  if (pieceEnd != input.npos) {
    ++pieceEnd;
  }
  return input.substr(lastPieceEnd, pieceEnd - lastPieceEnd);
}

template <>
template <>
qvac_lib_inference_addon_tts::Addon::Addon(
    js_env_t* env,
    std::unordered_map<std::string, std::string> configMap,
    js_value_t* jsHandle, js_value_t* outputCb, js_value_t* transitionCb)
    : env_{env}, transitionCb_{transitionCb}, model_{configMap} {

  initializeProcessingThread(env, jsHandle, outputCb, transitionCb);
  QLOG(logger::Priority::INFO,"TTS addon initialized successfully");
}

template <>
void qvac_lib_inference_addon_tts::Addon::processSignalUnloadWeights(std::string &input) {
  throw qvac_errors::StatusError(qvac_errors::general_error::InvalidArgument, "Invalid signal: UnloadWeights");
}

template <>
void qvac_lib_inference_addon_tts::Addon::processSignalFinetune(std::string &input) {
  throw qvac_errors::StatusError(qvac_errors::general_error::InvalidArgument, "Invalid signal: Finetune");
}

namespace output_handler {

template <>
js_value_t* createOutputData<std::vector<int16_t>>(js_env_t* env, const std::vector<int16_t>& data) {
  void* buffer = nullptr;
  js_value_t* arrayBuffer = nullptr;
  JS(js_create_arraybuffer(env, data.size() * sizeof(int16_t), &buffer, &arrayBuffer));

  js_value_t* typedArray = nullptr;
  JS(js_create_typedarray(env, js_int16array, data.size(), arrayBuffer, 0, &typedArray));

  std::memcpy(buffer, data.data(), data.size() * sizeof(int16_t));
  
  auto result = js::Object::create(env);
  result.setProperty(env, "outputArray", typedArray);
  return result;
}

}

}