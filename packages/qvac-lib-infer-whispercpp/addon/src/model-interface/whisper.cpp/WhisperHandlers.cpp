#include "WhisperHandlers.hpp"

#include <thread>

namespace qvac_lib_inference_addon_whisper {

constexpr int MAX_TEXT_CONTEXT = 4096;

int computeOptimalThreads() {
  size_t hwThreads = std::thread::hardware_concurrency();
  return hwThreads > 2 ? static_cast<int>(hwThreads / 2U) : 1;
}

const std::unordered_map<std::string, HandlerFunction<whisper_context_params>>
    WHISPER_CONTEXT_HANDLERS = {
        {"model",
         [](whisper_context_params& params, const JSValueVariant& value) {
           // model is passed in as a reset argument but it is required with
           // context_params.
         }},
        {"use_gpu",
         [](whisper_context_params& params, const JSValueVariant& value) {
           params.use_gpu = std::get<bool>(value);
         }},
        {"flash_attn",
         [](whisper_context_params& params, const JSValueVariant& value) {
           params.flash_attn = std::get<bool>(value);
         }},
        {"gpu_device",
         [](whisper_context_params& params, const JSValueVariant& value) {
           int gpuDevice = static_cast<int>(std::get<double>(value));
           params.gpu_device = gpuDevice;
         }}};

// Definition for whisper main handlers map
const std::unordered_map<std::string, HandlerFunction<whisper_full_params>>
    WHISPER_MAIN_HANDLERS = {
        {"strategy",
         [](whisper_full_params& params, const JSValueVariant& value) {
           auto strategy = std::get<std::string>(value);
           if (strategy == "greedy") {
             params.strategy = WHISPER_SAMPLING_GREEDY;
           } else if (strategy == "beam_search") {
             params.strategy = WHISPER_SAMPLING_BEAM_SEARCH;
           } else {
             throw qvac_errors::StatusError(
                 qvac_errors::general_error::InvalidArgument,
                 "Strategy must be: 'greedy' or 'beam_search'");
           }
         }},

        {"n_threads",
         [](whisper_full_params& params, const JSValueVariant& value) {
           int nThreads = static_cast<int>(std::get<double>(value));
           if (nThreads < 0) {
             throw qvac_errors::StatusError(
                 qvac_errors::general_error::InvalidArgument,
                 "n_threads must be greater than or equal to 0");
           }
           if (nThreads == 0) {
             params.n_threads = computeOptimalThreads();
           } else {
             params.n_threads = nThreads;
           }
         }},

        {"n_max_text_ctx",
         [](whisper_full_params& params, const JSValueVariant& value) {
           int nMaxTextCtx = static_cast<int>(std::get<double>(value));
           if (nMaxTextCtx <= 1) {
             throw qvac_errors::StatusError(
                 qvac_errors::general_error::InvalidArgument,
                 "n_max_text_ctx must be greater than 1 but less than 4096");
           }
           if (nMaxTextCtx >= MAX_TEXT_CONTEXT) {
             throw qvac_errors::StatusError(
                 qvac_errors::general_error::InvalidArgument,
                 "n_max_text_ctx must be less than 4096");
           }
           params.n_max_text_ctx = nMaxTextCtx;
         }},

        {"offset_ms",
         [](whisper_full_params& params, const JSValueVariant& value) {
           int offsetMs = static_cast<int>(std::get<double>(value));
           if (offsetMs < 0) {
             throw qvac_errors::StatusError(
                 qvac_errors::general_error::InvalidArgument,
                 "offset_ms must be greater than 0");
           }
           params.offset_ms = offsetMs;
         }},

        {"duration_ms",
         [](whisper_full_params& params, const JSValueVariant& value) {
           int durationMs = static_cast<int>(std::get<double>(value));
           if (durationMs < 0) {
             throw qvac_errors::StatusError(
                 qvac_errors::general_error::InvalidArgument,
                 "duration_ms must be greater than 0");
           }
           params.duration_ms = durationMs;
         }},

        {"translate",
         [](whisper_full_params& params, const JSValueVariant& value) {
           params.translate = std::get<bool>(value);
         }},

        {"no_context",
         [](whisper_full_params& params, const JSValueVariant& value) {
           params.no_context = std::get<bool>(value);
         }},

        {"no_timestamps",
         [](whisper_full_params& params, const JSValueVariant& value) {
           params.no_timestamps = std::get<bool>(value);
         }},

        {"single_segment",
         [](whisper_full_params& params, const JSValueVariant& value) {
           params.single_segment = std::get<bool>(value);
         }},

        {"print_special",
         [](whisper_full_params& params, const JSValueVariant& value) {
           params.print_special = std::get<bool>(value);
         }},

        {"print_progress",
         [](whisper_full_params& params, const JSValueVariant& value) {
           params.print_progress = std::get<bool>(value);
         }},

        {"print_realtime",
         [](whisper_full_params& params, const JSValueVariant& value) {
           params.print_realtime = std::get<bool>(value);
         }},

        {"print_timestamps",
         [](whisper_full_params& params, const JSValueVariant& value) {
           params.print_timestamps = std::get<bool>(value);
         }},

        {"token_timestamps",
         [](whisper_full_params& params, const JSValueVariant& value) {
           params.token_timestamps = std::get<bool>(value);
         }},

        {"thold_pt",
         [](whisper_full_params& params, const JSValueVariant& value) {
           auto tholdPt = std::get<double>(value);
           auto tholdPtFloat = static_cast<float>(tholdPt);
           if (tholdPtFloat < 0 || tholdPtFloat > 1) {
             throw qvac_errors::StatusError(
                 qvac_errors::general_error::InvalidArgument,
                 "thold_pt must be between 0 and 1");
           }
           params.thold_pt = tholdPtFloat;
         }},

        {"thold_ptsum",
         [](whisper_full_params& params, const JSValueVariant& value) {
           auto tholdPtsum = std::get<double>(value);
           auto tholdPtsumFloat = static_cast<float>(tholdPtsum);
           if (tholdPtsumFloat < 0 || tholdPtsumFloat > 1) {
             throw qvac_errors::StatusError(
                 qvac_errors::general_error::InvalidArgument,
                 "thold_ptsum must be between 0 and 1");
           }
           params.thold_ptsum = tholdPtsumFloat;
         }},

        {"max_len",
         [](whisper_full_params& params, const JSValueVariant& value) {
           int maxLen = static_cast<int>(std::get<double>(value));
           if (maxLen < 0) {
             throw qvac_errors::StatusError(
                 qvac_errors::general_error::InvalidArgument,
                 "max_len must be greater than 0 or set to 0 if you want the "
                 "default");
           }
           params.max_len = maxLen;
         }},

        {"split_on_word",
         [](whisper_full_params& params, const JSValueVariant& value) {
           params.split_on_word = std::get<bool>(value);
         }},

        {"max_tokens",
         [](whisper_full_params& params, const JSValueVariant& value) {
           int maxTokens = static_cast<int>(std::get<double>(value));
           if (maxTokens < 0) {
             throw qvac_errors::StatusError(
                 qvac_errors::general_error::InvalidArgument,
                 "max_tokens must be greater than 0 if you are limiting, and 0 "
                 "if you want unbounded");
           }
           params.max_tokens = maxTokens;
         }},

        {"debug_mode",
         [](whisper_full_params& params, const JSValueVariant& value) {
           params.debug_mode = std::get<bool>(value);
         }},

        {"audio_ctx",
         [](whisper_full_params& params, const JSValueVariant& value) {
           int audioCtx = static_cast<int>(std::get<double>(value));
           if (audioCtx < 0) {
             throw qvac_errors::StatusError(
                 qvac_errors::general_error::InvalidArgument,
                 "audio_ctx must be greater than 0, or 0 if you want to use "
                 "the default");
           }
           params.audio_ctx = audioCtx;
         }},

        {"tdrz_enable",
         [](whisper_full_params& params, const JSValueVariant& value) {
           params.tdrz_enable = std::get<bool>(value);
         }},

        {"suppress_regex",
         [](whisper_full_params& params, const JSValueVariant& value) {
           params.suppress_regex = std::get<std::string>(value).c_str();
         }},

        {"initial_prompt",
         [](whisper_full_params& params, const JSValueVariant& value) {
           params.initial_prompt = std::get<std::string>(value).c_str();
         }},

        {"language",
         [](whisper_full_params& params, const JSValueVariant& value) {
           const auto& language = std::get<std::string>(value);

           if (language.empty()) {
             throw qvac_errors::StatusError(
                 qvac_errors::general_error::InvalidArgument,
                 "language must be a non-empty string");
           }

           if (language == "auto") {
             params.language = nullptr;
             params.detect_language = true;
             return;
           }

           if (language.length() != 2) {
             throw qvac_errors::StatusError(
                 qvac_errors::general_error::InvalidArgument,
                 "language must be a 2 character string or auto not " +
                     language);
           }

           if (!checkLanguage(language)) {
             throw qvac_errors::StatusError(
                 qvac_errors::general_error::InvalidArgument,
                 "language must be a valid language code or auto not " +
                     language);
           }

           params.language = language.c_str();
           params.detect_language = false;
         }},

        {"detect_language",
         [](whisper_full_params& params, const JSValueVariant& value) {
           bool detectLanguage = std::get<bool>(value);

           // Get the current language setting to validate the combination
           std::string currentLanguage;
           if (params.language) {
             currentLanguage = std::string(params.language);
           }

           // handle detect language if set to false but on auto
           if (!detectLanguage && currentLanguage == "auto") {
             throw qvac_errors::StatusError(
                 qvac_errors::general_error::InvalidArgument,
                 "detect_language must be true if language is auto");
           }

           // handle detect language if set to true but language is not auto
           if (detectLanguage && currentLanguage != "auto") {
             throw qvac_errors::StatusError(
                 qvac_errors::general_error::InvalidArgument,
                 "detect_language must be false if language is not auto");
           }

           params.detect_language = detectLanguage;
         }},

        {"suppress_blank",
         [](whisper_full_params& params, const JSValueVariant& value) {
           params.suppress_blank = std::get<bool>(value);
         }},

        {"suppress_nst",
         [](whisper_full_params& params, const JSValueVariant& value) {
           params.suppress_nst = std::get<bool>(value);
         }},

        {"temperature",
         [](whisper_full_params& params, const JSValueVariant& value) {
           auto temp = std::get<double>(value);
           params.temperature = static_cast<float>(temp);
           if (params.temperature < 0.0 || params.temperature > 1.0) {
             throw qvac_errors::StatusError(
                 qvac_errors::general_error::InvalidArgument,
                 "temperature must be between 0 and 1");
           }
         }},

        {"max_initial_ts",
         [](whisper_full_params& params, const JSValueVariant& value) {
           auto maxInitialTs = std::get<double>(value);
           auto maxInitialTsFloat = static_cast<float>(maxInitialTs);
           if (maxInitialTsFloat <= 0) {
             throw qvac_errors::StatusError(
                 qvac_errors::general_error::InvalidArgument,
                 "max_initial_ts must be greater than 0");
           }
           params.max_initial_ts = maxInitialTsFloat;
         }},

        {"length_penalty",
         [](whisper_full_params& params, const JSValueVariant& value) {
           auto lengthPenalty = std::get<double>(value);
           auto lengthPenaltyFloat = static_cast<float>(lengthPenalty);
           if (lengthPenaltyFloat < 0) {
             throw qvac_errors::StatusError(
                 qvac_errors::general_error::InvalidArgument,
                 "length_penalty must be greater than 0");
           }
           params.length_penalty = lengthPenaltyFloat;
         }},

        {"temperature_inc",
         [](whisper_full_params& params, const JSValueVariant& value) {
           auto temperatureInc = std::get<double>(value);
           auto temperatureIncFloat = static_cast<float>(temperatureInc);
           if (temperatureIncFloat < 0) {
             throw qvac_errors::StatusError(
                 qvac_errors::general_error::InvalidArgument,
                 "temperature_inc must be greater than 0");
           }
           params.temperature_inc = temperatureIncFloat;
         }},

        {"entropy_thold",
         [](whisper_full_params& params, const JSValueVariant& value) {
           auto entropyThold = std::get<double>(value);
           auto entropyTholdFloat = static_cast<float>(entropyThold);
           if (entropyTholdFloat < 0) {
             throw qvac_errors::StatusError(
                 qvac_errors::general_error::InvalidArgument,
                 "entropy_thold must be greater than 0");
           }
           params.entropy_thold = entropyTholdFloat;
         }},

        {"logprob_thold",
         [](whisper_full_params& params, const JSValueVariant& value) {
           auto logProbThold = std::get<double>(value);
           auto logProbTholdFloat = static_cast<float>(logProbThold);
           if (logProbTholdFloat < 0.0F) {

             if (logProbThold == -1) {
               params.logprob_thold = -1.0F;
               return;
             }

             throw qvac_errors::StatusError(
                 qvac_errors::general_error::InvalidArgument,
                 "logprob_thold must be greater than 0");
           }
           if (logProbTholdFloat > 1.0F) {
             throw qvac_errors::StatusError(
                 qvac_errors::general_error::InvalidArgument,
                 "logprob_thold must be less than 1");
           }
           params.logprob_thold = logProbTholdFloat;
         }},

        {"no_speech_thold",
         [](whisper_full_params& params, const JSValueVariant& value) {
           auto noSpeechThold = std::get<double>(value);
           auto noSpeechTholdFloat = static_cast<float>(noSpeechThold);
           if (noSpeechTholdFloat < 0.0F) {
             throw qvac_errors::StatusError(
                 qvac_errors::general_error::InvalidArgument,
                 "no_speech_thold must be greater than 0");
           }
           params.no_speech_thold = noSpeechTholdFloat;
         }},

        {"greedy_best_of",
         [](whisper_full_params& params, const JSValueVariant& value) {
           int bestOf = static_cast<int>(std::get<double>(value));
           if (bestOf <= 1) {
             throw qvac_errors::StatusError(
                 qvac_errors::general_error::InvalidArgument,
                 "greedy_best_of must be greater than 1 or set to -1 if you "
                 "want to use the default");
           }
           params.greedy.best_of = bestOf;
         }},

        {"beam_search_beam_size",
         [](whisper_full_params& params, const JSValueVariant& value) {
           int beamSearchBeamSize = static_cast<int>(std::get<double>(value));
           if (beamSearchBeamSize <= 1) {
             throw qvac_errors::StatusError(
                 qvac_errors::general_error::InvalidArgument,
                 "beam_search_beam_size must be greater than 1 or set to -1 if "
                 "you want to use the default");
           }
           params.beam_search.beam_size = beamSearchBeamSize;
         }},
        {"vad_model_path",
         [](whisper_full_params& params, const JSValueVariant& value) {
           params.vad_model_path = std::get<std::string>(value).c_str();
           params.vad = true;
         }},
        {"seed",
         [](whisper_full_params& params, const JSValueVariant& value) {
           int seed = static_cast<int>(std::get<double>(value));
           params.seed = seed;
         }},
};

// Definition for whisper VAD handlers map
const std::unordered_map<std::string, HandlerFunction<whisper_vad_params>>
    WHISPER_VAD_HANDLERS = {

        {"threshold",
         [](whisper_vad_params& params, const JSValueVariant& value) {
           double vadThreshold = std::get<double>(value);
           auto vadThresholdFloat = static_cast<float>(vadThreshold);
           params.threshold = vadThresholdFloat;
         }},

        {"min_speech_duration_ms",
         [](whisper_vad_params& params, const JSValueVariant& value) {
           int vadMinSpeechDurationMs =
               static_cast<int>(std::get<double>(value));
           params.min_speech_duration_ms = vadMinSpeechDurationMs;
         }},

        {"min_silence_duration_ms",
         [](whisper_vad_params& params, const JSValueVariant& value) {
           int vadMinSilenceDurationMs =
               static_cast<int>(std::get<double>(value));
           params.min_silence_duration_ms = vadMinSilenceDurationMs;
         }},

        {"max_speech_duration_s",
         [](whisper_vad_params& params, const JSValueVariant& value) {
           double vadMaxSpeechDurationS = std::get<double>(value);
           auto vadMaxSpeechDurationSFloat =
               static_cast<float>(vadMaxSpeechDurationS);
           if (vadMaxSpeechDurationSFloat <= 0) {
             throw qvac_errors::StatusError(
                 qvac_errors::general_error::InvalidArgument,
                 "vad_max_speech_duration_s must be greater than 0");
           }
           params.max_speech_duration_s = vadMaxSpeechDurationSFloat;
         }},

        {"speech_pad_ms",
         [](whisper_vad_params& params, const JSValueVariant& value) {
           int vadSpeechPadMs = static_cast<int>(std::get<double>(value));
           params.speech_pad_ms = vadSpeechPadMs;
         }},

        {"samples_overlap",
         [](whisper_vad_params& params, const JSValueVariant& value) {
           double vadSamplesOverlap = std::get<double>(value);
           auto vadSamplesOverlapFloat = static_cast<float>(vadSamplesOverlap);
           if (vadSamplesOverlapFloat < 0 || vadSamplesOverlapFloat > 1) {
             throw qvac_errors::StatusError(
                 qvac_errors::general_error::InvalidArgument,
                 "vad_samples_overlap must be between 0 and 1");
           }
           params.samples_overlap = vadSamplesOverlapFloat;
         }}};

// Definition for misc handlers map
const std::unordered_map<std::string, HandlerFunction<MiscConfig>>
    MISC_HANDLERS = {
        {"caption_enabled",
         [](MiscConfig& miscParams, const JSValueVariant& value) {
           miscParams.captionModeEnabled = std::get<bool>(value);
         }},
        {"seed",
         [](MiscConfig& miscParams, const JSValueVariant& value) {
           int seed = static_cast<int>(std::get<double>(value));
           miscParams.seed = seed;
         }},

        // add in more of these later as neeeded.
};

} // namespace qvac_lib_inference_addon_whisper
