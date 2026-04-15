#include "BCIConfig.hpp"

#include <sstream>
#include <stdexcept>

namespace qvac_lib_inference_addon_bci {

std::string convertVariantToString(const JSValueVariant& value) {
  return std::visit(
      [](const auto& v) -> std::string {
        using T = std::decay_t<decltype(v)>;
        if constexpr (std::is_same_v<T, std::monostate>) {
          return "null";
        } else if constexpr (std::is_same_v<T, int>) {
          return std::to_string(v);
        } else if constexpr (std::is_same_v<T, double>) {
          std::ostringstream oss;
          oss << v;
          return oss.str();
        } else if constexpr (std::is_same_v<T, std::string>) {
          return v;
        } else if constexpr (std::is_same_v<T, bool>) {
          return v ? "true" : "false";
        }
        return "unknown";
      },
      value);
}

const HandlersMap<whisper_full_params>& getWhisperMainHandlers() {
  static const HandlersMap<whisper_full_params> handlers = {
      {"language",
       [](whisper_full_params& /*p*/, const JSValueVariant& /*v*/) {
         // Language is handled separately in toWhisperFullParams via
         // BCIConfig::lang_ to avoid static-local lifetime issues.
       }},
      {"n_threads",
       [](whisper_full_params& p, const JSValueVariant& v) {
         if (auto* i = std::get_if<int>(&v)) {
           p.n_threads = *i;
         }
       }},
      {"translate",
       [](whisper_full_params& p, const JSValueVariant& v) {
         if (auto* b = std::get_if<bool>(&v)) {
           p.translate = *b;
         }
       }},
      {"no_timestamps",
       [](whisper_full_params& p, const JSValueVariant& v) {
         if (auto* b = std::get_if<bool>(&v)) {
           p.no_timestamps = *b;
         }
       }},
      {"single_segment",
       [](whisper_full_params& p, const JSValueVariant& v) {
         if (auto* b = std::get_if<bool>(&v)) {
           p.single_segment = *b;
         }
       }},
      {"temperature",
       [](whisper_full_params& p, const JSValueVariant& v) {
         if (auto* d = std::get_if<double>(&v)) {
           p.temperature = static_cast<float>(*d);
         }
       }},
      {"suppress_nst",
       [](whisper_full_params& p, const JSValueVariant& v) {
         if (auto* b = std::get_if<bool>(&v)) {
           p.suppress_nst = *b;
         }
       }},
      {"duration_ms",
       [](whisper_full_params& p, const JSValueVariant& v) {
         if (auto* i = std::get_if<int>(&v)) {
           p.duration_ms = *i;
         }
       }},
  };
  return handlers;
}

const HandlersMap<whisper_context_params>& getWhisperContextHandlers() {
  static const HandlersMap<whisper_context_params> handlers = {
      {"use_gpu",
       [](whisper_context_params& p, const JSValueVariant& v) {
         if (auto* b = std::get_if<bool>(&v)) {
           p.use_gpu = *b;
         }
       }},
      {"flash_attn",
       [](whisper_context_params& p, const JSValueVariant& v) {
         if (auto* b = std::get_if<bool>(&v)) {
           p.flash_attn = *b;
         }
       }},
  };
  return handlers;
}

whisper_full_params toWhisperFullParams(BCIConfig& bciConfig) {
  whisper_full_params params = whisper_full_default_params(
      WHISPER_SAMPLING_BEAM_SEARCH);

  // BCI defaults matching the Python notebook's decode settings
  params.beam_search.beam_size = 4;
  params.suppress_nst = false;
  params.suppress_blank = false;
  params.temperature = 0.0F;
  params.no_timestamps = true;
  params.single_segment = true;
  params.no_context = true;
  params.length_penalty = 0.14F;
  params.max_initial_ts = 0;

  const auto& handlers = getWhisperMainHandlers();
  for (const auto& [key, value] : bciConfig.whisperMainCfg) {
    auto it = handlers.find(key);
    if (it != handlers.end()) {
      it->second(params, value);
    }
  }

  // Set language from config-owned storage so the pointer outlives params
  auto langIt = bciConfig.whisperMainCfg.find("language");
  if (langIt != bciConfig.whisperMainCfg.end()) {
    if (auto* s = std::get_if<std::string>(&langIt->second)) {
      bciConfig.lang_ = *s;
      params.language = bciConfig.lang_.c_str();
    }
  }

  return params;
}

whisper_context_params toWhisperContextParams(const BCIConfig& bciConfig) {
  whisper_context_params params = whisper_context_default_params();

  const auto& handlers = getWhisperContextHandlers();
  for (const auto& [key, value] : bciConfig.whisperContextCfg) {
    auto it = handlers.find(key);
    if (it != handlers.end()) {
      it->second(params, value);
    }
  }

  return params;
}

} // namespace qvac_lib_inference_addon_bci
