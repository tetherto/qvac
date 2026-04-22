#include "BCIConfig.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <type_traits>

#include "qvac-lib-inference-addon-cpp/Errors.hpp"

namespace qvac_lib_inference_addon_bci {

namespace {

// JS Number values arrive as double through the binding layer. Convert them
// safely to the target integer type, validating that the value is finite and
// within range.
int toInt(const JSValueVariant& v, const std::string& key) {
  if (const auto* d = std::get_if<double>(&v)) {
    if (!std::isfinite(*d)) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          key + " must be a finite number");
    }
    if (*d < static_cast<double>(std::numeric_limits<int>::min()) ||
        *d > static_cast<double>(std::numeric_limits<int>::max())) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          key + " is out of int32 range");
    }
    if (std::floor(*d) != *d) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          key + " must be an integer");
    }
    return static_cast<int>(*d);
  }
  if (const auto* i = std::get_if<int>(&v)) {
    return *i;
  }
  throw qvac_errors::StatusError(
      qvac_errors::general_error::InvalidArgument,
      key + " must be a number");
}

float toFloat(const JSValueVariant& v, const std::string& key) {
  if (const auto* d = std::get_if<double>(&v)) {
    if (!std::isfinite(*d)) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          key + " must be a finite number");
    }
    return static_cast<float>(*d);
  }
  if (const auto* i = std::get_if<int>(&v)) {
    return static_cast<float>(*i);
  }
  throw qvac_errors::StatusError(
      qvac_errors::general_error::InvalidArgument,
      key + " must be a number");
}

bool toBool(const JSValueVariant& v, const std::string& key) {
  if (const auto* b = std::get_if<bool>(&v)) {
    return *b;
  }
  throw qvac_errors::StatusError(
      qvac_errors::general_error::InvalidArgument,
      key + " must be a boolean");
}

const std::string& toString(const JSValueVariant& v, const std::string& key) {
  if (const auto* s = std::get_if<std::string>(&v)) {
    return *s;
  }
  throw qvac_errors::StatusError(
      qvac_errors::general_error::InvalidArgument,
      key + " must be a string");
}

int computeOptimalThreads() {
  const unsigned hw = std::thread::hardware_concurrency();
  return hw > 0 ? static_cast<int>(std::min<unsigned>(hw, 16U)) : 4;
}

void ensureRange(const std::string& key, double value, double lo, double hi) {
  if (value < lo || value > hi) {
    std::ostringstream oss;
    oss << key << " must be in [" << lo << ", " << hi << "], got " << value;
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument, oss.str());
  }
}

} // namespace

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
         int n = toInt(v, "n_threads");
         if (n < 0) {
           throw qvac_errors::StatusError(
               qvac_errors::general_error::InvalidArgument,
               "n_threads must be >= 0");
         }
         p.n_threads = (n == 0) ? computeOptimalThreads() : n;
       }},
      {"translate",
       [](whisper_full_params& p, const JSValueVariant& v) {
         p.translate = toBool(v, "translate");
       }},
      {"no_timestamps",
       [](whisper_full_params& p, const JSValueVariant& v) {
         p.no_timestamps = toBool(v, "no_timestamps");
       }},
      {"single_segment",
       [](whisper_full_params& p, const JSValueVariant& v) {
         p.single_segment = toBool(v, "single_segment");
       }},
      {"temperature",
       [](whisper_full_params& p, const JSValueVariant& v) {
         float t = toFloat(v, "temperature");
         ensureRange("temperature", t, 0.0, 2.0);
         p.temperature = t;
       }},
      {"suppress_nst",
       [](whisper_full_params& p, const JSValueVariant& v) {
         p.suppress_nst = toBool(v, "suppress_nst");
       }},
      {"suppress_blank",
       [](whisper_full_params& p, const JSValueVariant& v) {
         p.suppress_blank = toBool(v, "suppress_blank");
       }},
      {"duration_ms",
       [](whisper_full_params& p, const JSValueVariant& v) {
         int ms = toInt(v, "duration_ms");
         if (ms < 0) {
           throw qvac_errors::StatusError(
               qvac_errors::general_error::InvalidArgument,
               "duration_ms must be >= 0");
         }
         p.duration_ms = ms;
       }},
      {"print_special",
       [](whisper_full_params& p, const JSValueVariant& v) {
         p.print_special = toBool(v, "print_special");
       }},
      {"print_progress",
       [](whisper_full_params& p, const JSValueVariant& v) {
         p.print_progress = toBool(v, "print_progress");
       }},
      {"print_realtime",
       [](whisper_full_params& p, const JSValueVariant& v) {
         p.print_realtime = toBool(v, "print_realtime");
       }},
      {"print_timestamps",
       [](whisper_full_params& p, const JSValueVariant& v) {
         p.print_timestamps = toBool(v, "print_timestamps");
       }},
      {"detect_language",
       [](whisper_full_params& p, const JSValueVariant& v) {
         p.detect_language = toBool(v, "detect_language");
       }},
      {"greedy_best_of",
       [](whisper_full_params& p, const JSValueVariant& v) {
         int b = toInt(v, "greedy_best_of");
         ensureRange("greedy_best_of", b, 1, 32);
         p.greedy.best_of = b;
       }},
      {"beam_search_beam_size",
       [](whisper_full_params& p, const JSValueVariant& v) {
         int b = toInt(v, "beam_search_beam_size");
         ensureRange("beam_search_beam_size", b, 1, 32);
         p.beam_search.beam_size = b;
       }},
  };
  return handlers;
}

const HandlersMap<whisper_context_params>& getWhisperContextHandlers() {
  static const HandlersMap<whisper_context_params> handlers = {
      {"use_gpu",
       [](whisper_context_params& p, const JSValueVariant& v) {
         p.use_gpu = toBool(v, "use_gpu");
       }},
      {"flash_attn",
       [](whisper_context_params& p, const JSValueVariant& v) {
         p.flash_attn = toBool(v, "flash_attn");
       }},
      {"gpu_device",
       [](whisper_context_params& p, const JSValueVariant& v) {
         int d = toInt(v, "gpu_device");
         if (d < 0) {
           throw qvac_errors::StatusError(
               qvac_errors::general_error::InvalidArgument,
               "gpu_device must be >= 0");
         }
         p.gpu_device = d;
       }},
      {"model",
       [](whisper_context_params& /*p*/, const JSValueVariant& v) {
         // Consumed directly from whisperContextCfg["model"] in BCIModel::load.
         (void)toString(v, "model");
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
    if (it == handlers.end()) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          "Unknown whisperConfig key: " + key);
    }
    try {
      it->second(params, value);
    } catch (const qvac_errors::StatusError&) {
      throw;
    } catch (const std::exception& e) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          "error in whisperConfig handler: " + key + " | " + e.what());
    }
  }

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
    if (it == handlers.end()) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          "Unknown contextParams key: " + key);
    }
    try {
      it->second(params, value);
    } catch (const qvac_errors::StatusError&) {
      throw;
    } catch (const std::exception& e) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          "error in contextParams handler: " + key + " | " + e.what());
    }
  }

  return params;
}

} // namespace qvac_lib_inference_addon_bci
