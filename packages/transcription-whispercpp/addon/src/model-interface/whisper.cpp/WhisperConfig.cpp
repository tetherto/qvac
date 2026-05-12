#include "WhisperConfig.hpp"

#include <fstream>
#include <iostream>

#include "WhisperHandlers.hpp"

// print for all variants

namespace qvac_lib_inference_addon_whisper {
std::string convertVariantToString(const JSValueVariant& value) {
  if (std::holds_alternative<std::string>(value)) {
    return std::get<std::string>(value);
  }
  if (std::holds_alternative<int>(value)) {
    return std::to_string(std::get<int>(value));
  }
  if (std::holds_alternative<double>(value)) {
    return std::to_string(std::get<double>(value));
  }
  if (std::holds_alternative<bool>(value)) {
    return std::to_string(std::get<bool>(value));
  }
  return "unknown";
}

/*
toWhisperFullParams:

This function will take in config and pass in two maps.
The maps will iterate over each of the parameters in the config,
and override the values from whisper_full_default_params.

NOTE: Not all parameters that are defined in whisper_full_params
can be exposed to the js side.

For a list of them see the js-interface/JSAdapter.hpp file.

*/
whisper_full_params toWhisperFullParams(const WhisperConfig& whisperConfig) {

  // whisper.h struct that contains all parameters for the main call.
  whisper_full_params fullParams =
      whisper_full_default_params(WHISPER_SAMPLING_GREEDY);

  for (const auto& [key, value] : whisperConfig.whisperMainCfg) {
    try {
      WHISPER_MAIN_HANDLERS.at(key)(fullParams, value);
    } catch (const std::exception& e) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          "error in full handler: " + key + "| exception: " + e.what());
    }
  }

  for (const auto& [key, value] : whisperConfig.vadCfg) {
    try {
      WHISPER_VAD_HANDLERS.at(key)(fullParams.vad_params, value);
    } catch (const std::exception& e) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          "error in vad handler: " + key + "| exception: " + e.what());
    }
  }

  return fullParams;
}

whisper_context_params
toWhisperContextParams(const WhisperConfig& whisperConfig) {

  whisper_context_params contextParams = whisper_context_default_params();
  // GPU is opt-in: callers must explicitly set use_gpu=true.
  // Leaving it at the upstream default (true) causes a SIGSEGV at process exit
  // due to ggml Vulkan backend static cleanup (whisper.cpp#2373).
  contextParams.use_gpu = false;
  for (const auto& [key, value] : whisperConfig.whisperContextCfg) {
    try {
      WHISPER_CONTEXT_HANDLERS.at(key)(contextParams, value);
    } catch (const std::exception& e) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          "error in context handler: " + key + "| exception: " + e.what());
    }
  }

  return contextParams;
}

MiscConfig defaultMiscConfig(void) {
  return MiscConfig{.captionModeEnabled = false};
}

MiscConfig toMiscConfig(const WhisperConfig& whisperConfig) {
  MiscConfig miscParams = defaultMiscConfig();
  for (const auto& [key, value] : whisperConfig.miscConfig) {
    try {
      MISC_HANDLERS.at(key)(miscParams, value);
    } catch (const std::exception& e) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          "error in misc handler: " + key + "| exception: " + e.what());
    }
  }
  return miscParams;
}

} // namespace qvac_lib_inference_addon_whisper
