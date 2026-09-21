#include "WhisperConfig.hpp"
#include "addon/AsrErrors.hpp"

namespace qvac::asrggml::whisper {

// checks if the two character code is a valid language code
inline bool checkLanguage(const std::string& language) {
  // Use whisper_lang_id to check if the language is valid
  const int langId = whisper_lang_id(language.c_str());
  return langId != -1;
}

extern const std::unordered_map<
    std::string, HandlerFunction<whisper_full_params>>
    WHISPER_MAIN_HANDLERS;
extern const std::unordered_map<
    std::string, HandlerFunction<whisper_vad_params>>
    WHISPER_VAD_HANDLERS;
extern const std::unordered_map<
    std::string, HandlerFunction<whisper_context_params>>
    WHISPER_CONTEXT_HANDLERS;
extern const std::unordered_map<std::string, HandlerFunction<MiscConfig>>
    MISC_HANDLERS;

} // namespace qvac::asrggml::whisper
