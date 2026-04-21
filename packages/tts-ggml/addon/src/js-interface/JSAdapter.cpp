#include "js-interface/JSAdapter.hpp"

#include <string>
#include <unordered_map>

namespace qvac::ttsggml {

namespace js = qvac_lib_inference_addon_cpp::js;

namespace {

void addString(
    std::unordered_map<std::string, std::string>& out,
    js::Object obj, js_env_t* env, const char* key) {
  auto v = obj.getOptionalProperty<js::String>(env, key);
  if (v.has_value()) {
    out[key] = v.value().as<std::string>(env);
  }
}

void addBool(
    std::unordered_map<std::string, std::string>& out,
    js::Object obj, js_env_t* env, const char* key) {
  auto v = obj.getOptionalProperty<js::Boolean>(env, key);
  if (v.has_value()) {
    out[key] = v.value().as<bool>(env) ? "true" : "false";
  }
}

std::optional<int> tryParseInt(const std::unordered_map<std::string, std::string>& m,
                               const std::string& key) {
  auto it = m.find(key);
  if (it == m.end()) return std::nullopt;
  try {
    return std::stoi(it->second);
  } catch (...) {
    return std::nullopt;
  }
}

bool truthy(const std::unordered_map<std::string, std::string>& m,
            const std::string& key) {
  auto it = m.find(key);
  if (it == m.end()) return false;
  return it->second == "true" || it->second == "1";
}

} // namespace

std::unordered_map<std::string, std::string>
JSAdapter::flattenToStringMap(js::Object obj, js_env_t* env) {
  std::unordered_map<std::string, std::string> configMap;
  addString(configMap, obj, env, "language");
  addString(configMap, obj, env, "t3ModelPath");
  addString(configMap, obj, env, "s3genModelPath");
  addString(configMap, obj, env, "referenceAudio");
  addString(configMap, obj, env, "voiceDir");
  addString(configMap, obj, env, "seed");
  addString(configMap, obj, env, "threads");
  addString(configMap, obj, env, "nGpuLayers");
  addString(configMap, obj, env, "outputSampleRate");
  addString(configMap, obj, env, "streamChunkTokens");
  addString(configMap, obj, env, "streamFirstChunkTokens");
  addString(configMap, obj, env, "cfmSteps");
  addBool(configMap, obj, env, "useGPU");
  addBool(configMap, obj, env, "lazySessionLoading");
  return configMap;
}

chatterbox::ChatterboxConfig JSAdapter::buildConfig(
    js::Object configurationParams, js_env_t* env) {
  auto map = flattenToStringMap(configurationParams, env);

  chatterbox::ChatterboxConfig cfg;
  if (auto it = map.find("t3ModelPath"); it != map.end()) cfg.t3ModelPath = it->second;
  if (auto it = map.find("s3genModelPath"); it != map.end()) cfg.s3genModelPath = it->second;
  if (auto it = map.find("language"); it != map.end()) cfg.language = it->second;
  if (auto it = map.find("referenceAudio"); it != map.end()) cfg.referenceAudio = it->second;
  if (auto it = map.find("voiceDir"); it != map.end()) cfg.voiceDir = it->second;
  cfg.seed = tryParseInt(map, "seed");
  cfg.threads = tryParseInt(map, "threads");
  cfg.nGpuLayers = tryParseInt(map, "nGpuLayers");
  cfg.outputSampleRate = tryParseInt(map, "outputSampleRate");
  cfg.useGpu = truthy(map, "useGPU");

  // `streamChunkTokens`, `streamFirstChunkTokens`, `cfmSteps`,
  // `lazySessionLoading` arrive in `map` but are unused by the argv-based
  // synthesizer today; they're reserved for the persistent-engine
  // streaming milestone.

  return cfg;
}

void JSAdapter::applyJobOverrides(
    chatterbox::ChatterboxConfig& cfg,
    const std::unordered_map<std::string, std::string>& overrides) {
  if (auto sr = tryParseInt(overrides, "outputSampleRate"); sr.has_value()) {
    cfg.outputSampleRate = sr;
  }
}

} // namespace qvac::ttsggml
