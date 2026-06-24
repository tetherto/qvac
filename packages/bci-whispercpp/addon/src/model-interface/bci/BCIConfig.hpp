#pragma once

#include <cstdint>
#include <functional>
#include <map>
#include <optional>
#include <string>
#include <unordered_map>
#include <variant>

#include <whisper.h>

namespace qvac_lib_inference_addon_bci {

using JSValueVariant =
    std::variant<std::monostate, int, double, std::string, bool>;

template <typename Params>
using HandlerFunction = std::function<void(Params&, const JSValueVariant&)>;

template <typename Params>
using HandlersMap = std::unordered_map<std::string, HandlerFunction<Params>>;

struct BCIConfig {
  std::map<std::string, JSValueVariant> miscConfig;
  std::map<std::string, JSValueVariant> whisperMainCfg;
  std::map<std::string, JSValueVariant> whisperContextCfg;
  std::map<std::string, JSValueVariant> bciConfig;

  // Addon prebuilds folder (`configurationParams.backendsDir` from JS).
  // Combined with the compile-time `BACKENDS_SUBDIR` to locate the
  // per-arch ggml `.so` modules for `ggml_backend_load_all_from_path()`.
  // Android-only; empty elsewhere. Mirrors WhisperConfig::backendsDir
  // in transcription-whispercpp 0.9.0.
  std::string backendsDir;

  // Explicit path to the BCI embedder weights file
  // (`configurationParams.embedderPath` from JS). When empty, BCIModel
  // falls back to resolving `bci-embedder.bin` next to the GGML model
  // file. Lets callers store the embedder separately from the model.
  std::string embedderPath;

  // Owned storage for string values that whisper_full_params references by
  // pointer (e.g. p.language = lang_.c_str()). Must outlive the params struct.
  mutable std::string lang_;
};

whisper_full_params toWhisperFullParams(BCIConfig& bciConfig);
whisper_context_params toWhisperContextParams(const BCIConfig& bciConfig);

std::string convertVariantToString(const JSValueVariant& value);

// Maps of handler functions for setting whisper_full_params fields from JS.
const HandlersMap<whisper_full_params>& getWhisperMainHandlers();
const HandlersMap<whisper_context_params>& getWhisperContextHandlers();

} // namespace qvac_lib_inference_addon_bci
