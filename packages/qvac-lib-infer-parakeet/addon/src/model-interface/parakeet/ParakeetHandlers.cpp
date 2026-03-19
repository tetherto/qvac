#include "ParakeetHandlers.hpp"

#include <algorithm>
#include <array>
#include <ranges>
#include <thread>

#include "qvac-lib-inference-addon-cpp/Errors.hpp"

namespace qvac_lib_infer_parakeet {

int computeOptimalThreads() {
  size_t hwThreads = std::thread::hardware_concurrency();
  return hwThreads > 2 ? static_cast<int>(hwThreads / 2U) : 1;
}

constexpr std::array VALID_SAMPLE_RATES = {8000, 16000, 22050, 44100, 48000};

const HandlersMap<ParakeetConfig> PARAKEET_MODEL_HANDLERS = {
    {"model", [](ParakeetConfig& config, const JSValueVariant& value) {}},

    {"modelPath",
     [](ParakeetConfig& config, const JSValueVariant& value) {
       const auto& path = std::get<std::string>(value);
       if (path.empty()) {
         throw qvac_errors::StatusError(
             qvac_errors::general_error::InvalidArgument,
             "modelPath must be a non-empty string");
       }
       config.modelPath = path;
     }},

    {"path",
     [](ParakeetConfig& config, const JSValueVariant& value) {
       const auto& path = std::get<std::string>(value);
       if (path.empty()) {
         throw qvac_errors::StatusError(
             qvac_errors::general_error::InvalidArgument,
             "path must be a non-empty string");
       }
       config.modelPath = path;
     }},

    {"modelType",
     [](ParakeetConfig& config, const JSValueVariant& value) {
       const auto& typeStr = std::get<std::string>(value);
       if (typeStr == "ctc") {
         config.modelType = ModelType::CTC;
       } else if (typeStr == "tdt") {
         config.modelType = ModelType::TDT;
       } else if (typeStr == "eou") {
         config.modelType = ModelType::EOU;
       } else if (typeStr == "sortformer") {
         config.modelType = ModelType::SORTFORMER;
       } else {
         throw qvac_errors::StatusError(
             qvac_errors::general_error::InvalidArgument,
             "modelType must be one of: 'ctc', 'tdt', 'eou', 'sortformer'");
       }
     }},

    {"useGPU",
     [](ParakeetConfig& config, const JSValueVariant& value) {
       config.useGPU = std::get<bool>(value);
     }},

    {"maxThreads",
     [](ParakeetConfig& config, const JSValueVariant& value) {
       int threads = static_cast<int>(std::get<double>(value));
       if (threads < 0) {
         throw qvac_errors::StatusError(
             qvac_errors::general_error::InvalidArgument,
             "maxThreads must be greater than or equal to 0");
       }
       if (threads == 0) {
         config.maxThreads = computeOptimalThreads();
       } else {
         config.maxThreads = threads;
       }
     }},
};

const HandlersMap<ParakeetConfig> PARAKEET_AUDIO_HANDLERS = {
    {"sampleRate",
     [](ParakeetConfig& config, const JSValueVariant& value) {
       int rate = static_cast<int>(std::get<double>(value));
       if (std::ranges::find(VALID_SAMPLE_RATES, rate) ==
           VALID_SAMPLE_RATES.end()) {
         throw qvac_errors::StatusError(
             qvac_errors::general_error::InvalidArgument,
             "sampleRate must be one of: 8000, 16000, 22050, 44100, 48000");
       }
       config.sampleRate = rate;
     }},

    {"channels",
     [](ParakeetConfig& config, const JSValueVariant& value) {
       int ch = static_cast<int>(std::get<double>(value));
       if (ch != 1 && ch != 2) {
         throw qvac_errors::StatusError(
             qvac_errors::general_error::InvalidArgument,
             "channels must be 1 (mono) or 2 (stereo)");
       }
       config.channels = ch;
     }},
};

const HandlersMap<ParakeetConfig> PARAKEET_TRANSCRIPTION_HANDLERS = {};

const HandlersMap<MiscConfig> PARAKEET_MISC_HANDLERS = {
    {"captionEnabled",
     [](MiscConfig& config, const JSValueVariant& value) {
       config.captionEnabled = std::get<bool>(value);
     }},

    {"timestampsEnabled",
     [](MiscConfig& config, const JSValueVariant& value) {
       config.timestampsEnabled = std::get<bool>(value);
     }},

    {"seed",
     [](MiscConfig& config, const JSValueVariant& value) {
       int seed = static_cast<int>(std::get<double>(value));
       config.seed = seed;
     }},
};

} // namespace qvac_lib_infer_parakeet
