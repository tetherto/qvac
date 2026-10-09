#ifndef WHISPERCONFIG_H
#define WHISPERCONFIG_H

#include <cstdint>
#include <functional>
#include <map>
#include <optional>
#include <span>
#include <string>
#include <unordered_map>
#include <variant>

#include <whisper.h>
namespace qvac::asrggml::whisper {

class JSAdapter;

using JSValueVariant =
    std::variant<std::monostate, int, double, std::string, bool>;

/*
 Needs to handle both
 - whisper_full_params
 - whisper_context_params
 and probably more later.
*/

template <typename Params>
using HandlerFunction = std::function<void(Params&, const JSValueVariant&)>;

template <typename Params>
using HandlersMap = std::unordered_map<std::string, HandlerFunction<Params>>;

struct WhisperConfig {
  std::map<std::string, JSValueVariant> miscConfig;
  std::map<std::string, JSValueVariant> whisperMainCfg;
  std::map<std::string, JSValueVariant> vadCfg;
  std::map<std::string, JSValueVariant> whisperContextCfg;

  // Directory scanned, as given, for the ggml `.so` / `.dll` modules
  // (`configurationParams.backendsDir` from JS). Empty scans the addon's own.
  std::string backendsDir;
};

struct MiscConfig {
  bool captionModeEnabled;
  // Applied before the whisper.cpp call rather than passed as a
  // whisper_full_params field. Holds addon-side knobs that influence model
  // input/output without being native whisper parameters.
  int seed;
};

MiscConfig defaultMiscConfig();

whisper_full_params toWhisperFullParams(const WhisperConfig& whisperConfig);

whisper_context_params
toWhisperContextParams(const WhisperConfig& whisperConfig);

MiscConfig toMiscConfig(const WhisperConfig& whisperConfig);

std::string convertVariantToString(const JSValueVariant& value);
} // namespace qvac::asrggml::whisper

#endif // WHISPERCONFIG_H
