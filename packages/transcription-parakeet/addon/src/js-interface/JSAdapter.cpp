#include "JSAdapter.hpp"

#include "inference-addon-cpp/JsUtils.hpp"
#include "inference-addon-cpp/Logger.hpp"

namespace qvac_lib_infer_parakeet {

using namespace qvac_lib_inference_addon_cpp;

auto JSAdapter::loadFromJSObject(js::Object jsObject, js_env_t* env)
    -> ParakeetConfig {
  ParakeetConfig config;

  auto modelPathOpt =
      jsObject.getOptionalProperty<js::String>(env, "modelPath");
  if (modelPathOpt.has_value()) {
    config.modelPath = modelPathOpt.value().as<std::string>(env);
  }

  auto pathOpt = jsObject.getOptionalProperty<js::String>(env, "path");
  if (pathOpt.has_value()) {
    config.modelPath = pathOpt.value().as<std::string>(env);
  }

  auto threadsOpt = jsObject.getOptionalProperty<js::Number>(env, "maxThreads");
  if (threadsOpt.has_value()) {
    config.maxThreads = threadsOpt.value().as<int32_t>(env);
  }

  auto gpuOpt = jsObject.getOptionalProperty<js::Boolean>(env, "useGPU");
  if (gpuOpt.has_value()) {
    config.useGPU = gpuOpt.value().as<bool>(env);
  }

  auto sampleRateOpt =
      jsObject.getOptionalProperty<js::Number>(env, "sampleRate");
  if (sampleRateOpt.has_value()) {
    config.sampleRate = sampleRateOpt.value().as<int32_t>(env);
  }

  auto channelsOpt = jsObject.getOptionalProperty<js::Number>(env, "channels");
  if (channelsOpt.has_value()) {
    config.channels = channelsOpt.value().as<int32_t>(env);
  }

  auto captionOpt =
      jsObject.getOptionalProperty<js::Boolean>(env, "captionEnabled");
  if (captionOpt.has_value()) {
    config.captionEnabled = captionOpt.value().as<bool>(env);
  }

  auto timestampsOpt =
      jsObject.getOptionalProperty<js::Boolean>(env, "timestampsEnabled");
  if (timestampsOpt.has_value()) {
    config.timestampsEnabled = timestampsOpt.value().as<bool>(env);
  }

  auto seedOpt = jsObject.getOptionalProperty<js::Number>(env, "seed");
  if (seedOpt.has_value()) {
    config.seed = seedOpt.value().as<int32_t>(env);
  }

  // Streaming mode (see ParakeetConfig comments). All fields optional;
  // unspecified values keep ParakeetConfig's defaults.
  auto streamingOpt =
      jsObject.getOptionalProperty<js::Boolean>(env, "streaming");
  if (streamingOpt.has_value()) {
    config.streaming = streamingOpt.value().as<bool>(env);
  }

  auto streamingChunkMsOpt =
      jsObject.getOptionalProperty<js::Number>(env, "streamingChunkMs");
  if (streamingChunkMsOpt.has_value()) {
    config.streamingChunkMs = streamingChunkMsOpt.value().as<int32_t>(env);
  }

  auto streamingHistoryMsOpt =
      jsObject.getOptionalProperty<js::Number>(env, "streamingHistoryMs");
  if (streamingHistoryMsOpt.has_value()) {
    config.streamingHistoryMs = streamingHistoryMsOpt.value().as<int32_t>(env);
  }

  auto streamingEmitPartialsOpt =
      jsObject.getOptionalProperty<js::Boolean>(env, "streamingEmitPartials");
  if (streamingEmitPartialsOpt.has_value()) {
    config.streamingEmitPartials = streamingEmitPartialsOpt.value().as<bool>(env);
  }

  auto streamingEnergyVadOpt =
      jsObject.getOptionalProperty<js::Boolean>(env, "streamingEnergyVad");
  if (streamingEnergyVadOpt.has_value()) {
    config.streamingEnergyVad = streamingEnergyVadOpt.value().as<bool>(env);
  }

  auto streamingLeftContextMsOpt =
      jsObject.getOptionalProperty<js::Number>(env, "streamingLeftContextMs");
  if (streamingLeftContextMsOpt.has_value()) {
    config.streamingLeftContextMs =
        streamingLeftContextMsOpt.value().as<int32_t>(env);
  }

  auto streamingRightLookaheadMsOpt =
      jsObject.getOptionalProperty<js::Number>(
          env, "streamingRightLookaheadMs");
  if (streamingRightLookaheadMsOpt.has_value()) {
    config.streamingRightLookaheadMs =
        streamingRightLookaheadMsOpt.value().as<int32_t>(env);
  }

  // AOSC (v2.1+ Sortformer only). All optional; unspecified values keep
  // ParakeetConfig's defaults. Forwarded into
  // parakeet::SortformerStreamingOptions by ParakeetModel /
  // ParakeetStreamingProcessor; ignored for v1/v2/non-Sortformer.
  auto streamingSpkCacheEnableOpt =
      jsObject.getOptionalProperty<js::Boolean>(env, "streamingSpkCacheEnable");
  if (streamingSpkCacheEnableOpt.has_value()) {
    config.streamingSpkCacheEnable =
        streamingSpkCacheEnableOpt.value().as<bool>(env);
  }

  auto streamingSpkCacheLenOpt =
      jsObject.getOptionalProperty<js::Number>(env, "streamingSpkCacheLen");
  if (streamingSpkCacheLenOpt.has_value()) {
    config.streamingSpkCacheLen =
        streamingSpkCacheLenOpt.value().as<int32_t>(env);
  }

  auto streamingFifoLenOpt =
      jsObject.getOptionalProperty<js::Number>(env, "streamingFifoLen");
  if (streamingFifoLenOpt.has_value()) {
    config.streamingFifoLen = streamingFifoLenOpt.value().as<int32_t>(env);
  }

  auto streamingChunkLeftContextMsOpt =
      jsObject.getOptionalProperty<js::Number>(
          env, "streamingChunkLeftContextMs");
  if (streamingChunkLeftContextMsOpt.has_value()) {
    config.streamingChunkLeftContextMs =
        streamingChunkLeftContextMsOpt.value().as<int32_t>(env);
  }

  auto streamingChunkRightContextMsOpt =
      jsObject.getOptionalProperty<js::Number>(
          env, "streamingChunkRightContextMs");
  if (streamingChunkRightContextMsOpt.has_value()) {
    config.streamingChunkRightContextMs =
        streamingChunkRightContextMsOpt.value().as<int32_t>(env);
  }

  auto streamingSpkCacheUpdatePeriodOpt =
      jsObject.getOptionalProperty<js::Number>(
          env, "streamingSpkCacheUpdatePeriod");
  if (streamingSpkCacheUpdatePeriodOpt.has_value()) {
    config.streamingSpkCacheUpdatePeriod =
        streamingSpkCacheUpdatePeriodOpt.value().as<int32_t>(env);
  }

  // Dynamic-backend loading knobs. Both forwarded to
  // parakeet::EngineOptions and consumed once per-process on the
  // first Engine construction (the ggml-backend registry + the
  // ggml-opencl program-binary cache are both process singletons --
  // see parakeet::set_backends_directory / set_opencl_cache_dir for
  // the detailed lifetime contract). Empty -> leave the existing
  // setting alone.
  auto backendsDirOpt =
      jsObject.getOptionalProperty<js::String>(env, "backendsDir");
  if (backendsDirOpt.has_value()) {
    config.backendsDir = backendsDirOpt.value().as<std::string>(env);
  }

  auto openclCacheDirOpt =
      jsObject.getOptionalProperty<js::String>(env, "openclCacheDir");
  if (openclCacheDirOpt.has_value()) {
    config.openclCacheDir = openclCacheDirOpt.value().as<std::string>(env);
  }

  auto innerConfigOpt = jsObject.getOptionalProperty<js::Object>(env, "config");
  if (innerConfigOpt.has_value()) {
    loadModelParams(innerConfigOpt.value(), env, config);
  }

  return config;
}

auto JSAdapter::loadModelParams(js::Object modelParamsObj, js_env_t *env,
                                ParakeetConfig &parakeetConfig)
    -> ParakeetConfig {
  auto threadsOpt =
      modelParamsObj.getOptionalProperty<js::Number>(env, "maxThreads");
  if (threadsOpt.has_value()) {
    parakeetConfig.maxThreads = threadsOpt.value().as<int32_t>(env);
  }

  auto gpuOpt = modelParamsObj.getOptionalProperty<js::Boolean>(env, "useGPU");
  if (gpuOpt.has_value()) {
    parakeetConfig.useGPU = gpuOpt.value().as<bool>(env);
  }

  return parakeetConfig;
}

auto JSAdapter::loadAudioParams(js::Object audioParamsObj, js_env_t *env,
                                ParakeetConfig &parakeetConfig)
    -> ParakeetConfig {
  auto sampleRateOpt =
      audioParamsObj.getOptionalProperty<js::Number>(env, "sampleRate");
  if (sampleRateOpt.has_value()) {
    parakeetConfig.sampleRate = sampleRateOpt.value().as<int32_t>(env);
  }

  auto channelsOpt =
      audioParamsObj.getOptionalProperty<js::Number>(env, "channels");
  if (channelsOpt.has_value()) {
    parakeetConfig.channels = channelsOpt.value().as<int32_t>(env);
  }

  return parakeetConfig;
}

} // namespace qvac_lib_infer_parakeet
