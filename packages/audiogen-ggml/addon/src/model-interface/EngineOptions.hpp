#pragma once

#include <audiogen-cpp/acestep/engine.h>
#include <audiogen-cpp/minimax/engine.h>

#include "model-interface/acestep/AcestepConfig.hpp"
#include "model-interface/minimax/MinimaxConfig.hpp"

namespace qvac::audiogenggml {

inline tts_cpp::acestep::EngineOptions
engineOptions(const acestep::AcestepConfig& config) {
  tts_cpp::acestep::EngineOptions options;
  options.models_dir = config.modelDir;
  options.text_enc_model_path = config.textEncModelPath;
  options.lm_model_path = config.lmModelPath;
  options.dit_model_path = config.ditModelPath;
  options.vae_model_path = config.vaeModelPath;
  options.n_threads = config.threads;
  options.n_gpu_layers = config.useGpu ? config.nGpuLayers : 0;
  if (!config.backend.empty()) {
    options.backend = config.backend;
  }
  if (!config.lmBackend.empty()) {
    options.lm_backend = config.lmBackend;
  }
  options.dump_stages_dir = config.dumpStagesDir;
  return options;
}

inline tts_cpp::minimax::EngineOptions
engineOptions(const minimax::MinimaxConfig& config) {
  tts_cpp::minimax::EngineOptions options;
  options.model_dir = config.modelDir;
  options.lm_model_path = config.lmModelPath;
  options.synth_model_path = config.synthModelPath;
  options.n_threads = config.threads;
  options.coreml_conditioner_path = config.coremlConditionerPath;
  options.coreml_profile_dir = config.coremlProfileDir;
  options.coreml_compute_units = config.coremlComputeUnits;
  options.device =
      config.device.empty() ? (config.useGpu ? "auto" : "cpu") : config.device;
  return options;
}

} // namespace qvac::audiogenggml
