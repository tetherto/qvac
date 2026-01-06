#include "WhisperConfig.hpp"
#include "addon/WhisperErrors.hpp"

namespace qvac_lib_inference_addon_whisper {

// checks if the two character code is a valid language code
inline bool checkLanguage(const std::string& language) {
  // Use whisper_lang_id to check if the language is valid
  const int LANG_ID = whisper_lang_id(language.c_str());
  return LANG_ID != -1;
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

} // namespace qvac_lib_inference_addon_whisper
