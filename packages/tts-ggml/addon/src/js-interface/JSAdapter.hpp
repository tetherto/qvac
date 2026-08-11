#pragma once

#include <string>

#include <inference-addon-cpp/JsUtils.hpp>
#include <js.h>
#include <tts-cpp/cosyvoice/engine.h>

#include "model-interface/chatterbox/ChatterboxConfig.hpp"
#include "model-interface/cosyvoice/CosyvoiceConfig.hpp"
#include "model-interface/parler/ParlerConfig.hpp"
#include "model-interface/supertonic/SupertonicConfig.hpp"

namespace qvac::ttsggml {

enum class EngineType {
  Chatterbox,
  Supertonic,
  Cosyvoice,
  Parler,
};

class JSAdapter {
public:
  JSAdapter() = default;

  EngineType readEngineType(
      qvac_lib_inference_addon_cpp::js::Object configurationParams,
      js_env_t* env);

  chatterbox::ChatterboxConfig buildChatterboxConfig(
      qvac_lib_inference_addon_cpp::js::Object configurationParams,
      js_env_t* env);

  supertonic::SupertonicConfig buildSupertonicConfig(
      qvac_lib_inference_addon_cpp::js::Object configurationParams,
      js_env_t* env);

  cosyvoice::CosyvoiceConfig buildCosyvoiceConfig(
      qvac_lib_inference_addon_cpp::js::Object configurationParams,
      js_env_t* env);

  parler::ParlerConfig buildParlerConfig(
      qvac_lib_inference_addon_cpp::js::Object configurationParams,
      js_env_t* env);

  // Shared by buildParlerConfig and the per-call runJob path (the same
  // description/template properties are legal on both objects).
  parler::ParlerDescriptionFields readParlerDescriptionFields(
      qvac_lib_inference_addon_cpp::js::Object obj, js_env_t* env);

  // Cross-engine conditioning, legal on both the config and the job object.
  tts_cpp::cosyvoice::VoiceControls readVoiceControls(
      qvac_lib_inference_addon_cpp::js::Object obj, js_env_t* env);

  // Supertonic takes its conditioning at construction only; reject a job
  // object that carries some, rather than dropping it on the way to the engine.
  void assertNoPerCallSupertonicControls(
      qvac_lib_inference_addon_cpp::js::Object obj, js_env_t* env);
};

}
