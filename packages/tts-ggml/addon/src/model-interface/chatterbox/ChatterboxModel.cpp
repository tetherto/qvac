#include "model-interface/chatterbox/ChatterboxModel.hpp"

#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <random>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

#include <qvac-tts/qvac-tts.h>

#include "addon/TTSErrors.hpp"

namespace qvac::ttsggml::chatterbox {

namespace {

using qvac_errors::createTTSError;
using qvac_errors::tts_error::TTSErrorCode;

std::filesystem::path makeScratchWavPath() {
  auto dir = std::filesystem::temp_directory_path();
  std::random_device rd;
  std::mt19937_64 rng(rd());
  const uint64_t rnd = rng();
  std::ostringstream name;
  name << "qvac-tts-ggml-" << std::hex << rnd << ".wav";
  return dir / name.str();
}

/** Minimal PCM16 WAV reader. The qvac-tts CLI always writes 16-bit mono PCM
 *  at 24 kHz (see the HiFT vocoder output path in qvac-tts.cpp).  We don't
 *  need to support the full spec — just RIFF/WAVE, a fmt chunk with format=1
 *  channels=1 bits=16, and a data chunk.  Anything else is an engine bug and
 *  we'd rather fail loudly. */
std::vector<int16_t> readPcm16Wav(const std::filesystem::path& path, int& sampleRate) {
  std::ifstream f(path, std::ios::binary);
  if (!f) {
    throw createTTSError(TTSErrorCode::SynthesisFailed, "failed to open synthesized wav: " + path.string());
  }
  std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(f)),
                             std::istreambuf_iterator<char>());
  if (bytes.size() < 44) {
    throw createTTSError(TTSErrorCode::SynthesisFailed, "synthesized wav is truncated (< 44 bytes): " + path.string());
  }

  auto read_u32_le = [](const uint8_t* p) {
    return uint32_t(p[0]) | (uint32_t(p[1]) << 8) | (uint32_t(p[2]) << 16) |
           (uint32_t(p[3]) << 24);
  };
  auto read_u16_le = [](const uint8_t* p) {
    return uint16_t(p[0]) | (uint16_t(p[1]) << 8);
  };

  if (std::memcmp(bytes.data(), "RIFF", 4) != 0 ||
      std::memcmp(bytes.data() + 8, "WAVE", 4) != 0) {
    throw createTTSError(TTSErrorCode::SynthesisFailed, "synthesized wav missing RIFF/WAVE header");
  }

  size_t cursor = 12;
  uint16_t audioFormat = 0;
  uint16_t numChannels = 0;
  uint32_t sr = 0;
  uint16_t bitsPerSample = 0;
  const uint8_t* dataPtr = nullptr;
  size_t dataBytes = 0;

  while (cursor + 8 <= bytes.size()) {
    const uint8_t* id = bytes.data() + cursor;
    const uint32_t sz = read_u32_le(bytes.data() + cursor + 4);
    cursor += 8;
    if (cursor + sz > bytes.size()) break;
    if (std::memcmp(id, "fmt ", 4) == 0) {
      if (sz < 16) {
        throw createTTSError(TTSErrorCode::SynthesisFailed, "synthesized wav fmt chunk too small");
      }
      audioFormat = read_u16_le(bytes.data() + cursor);
      numChannels = read_u16_le(bytes.data() + cursor + 2);
      sr = read_u32_le(bytes.data() + cursor + 4);
      bitsPerSample = read_u16_le(bytes.data() + cursor + 14);
    } else if (std::memcmp(id, "data", 4) == 0) {
      dataPtr = bytes.data() + cursor;
      dataBytes = sz;
      break;
    }
    cursor += sz;
    if ((sz & 1U) != 0U) cursor += 1; // pad byte
  }

  if (audioFormat != 1 || numChannels != 1 || bitsPerSample != 16 ||
      dataPtr == nullptr) {
    throw createTTSError(TTSErrorCode::SynthesisFailed, "synthesized wav is not 16-bit mono PCM");
  }
  sampleRate = static_cast<int>(sr);
  const size_t nSamples = dataBytes / sizeof(int16_t);
  std::vector<int16_t> pcm(nSamples);
  std::memcpy(pcm.data(), dataPtr, nSamples * sizeof(int16_t));
  return pcm;
}

/** Owning argv builder — keeps strings alive while the argv pointers are used. */
class ArgvBuilder {
public:
  void add(std::string arg) { storage_.emplace_back(std::move(arg)); }
  // Call after all adds.  Returned (char**, size) pair stays valid while
  // this builder is alive.
  std::pair<char**, int> buildArgv() {
    pointers_.clear();
    pointers_.reserve(storage_.size());
    for (auto& s : storage_) {
      pointers_.push_back(s.data());
    }
    return {pointers_.data(), static_cast<int>(pointers_.size())};
  }

private:
  std::vector<std::string> storage_;
  std::vector<char*> pointers_;
};

int readIntOverride(
    const ChatterboxModel::JobConfig& overrides, const std::string& key) {
  auto it = overrides.find(key);
  if (it == overrides.end()) return -1;
  try {
    return std::stoi(it->second);
  } catch (...) {
    return -1;
  }
}

} // namespace

ChatterboxModel::ChatterboxModel(ChatterboxConfig config)
    : cfg_(std::move(config)) {
  validatePaths(cfg_);
}

void ChatterboxModel::validatePaths(const ChatterboxConfig& cfg) {
  if (cfg.t3ModelPath.empty()) {
    throw createTTSError(TTSErrorCode::ModelFileNotFound, "t3ModelPath is required");
  }
  if (cfg.s3genModelPath.empty()) {
    throw createTTSError(TTSErrorCode::ModelFileNotFound, "s3genModelPath is required");
  }
  if (!std::filesystem::exists(cfg.t3ModelPath)) {
    throw createTTSError(TTSErrorCode::ModelFileNotFound, "t3 model not found: " + cfg.t3ModelPath);
  }
  if (!std::filesystem::exists(cfg.s3genModelPath)) {
    throw createTTSError(TTSErrorCode::ModelFileNotFound, "s3gen model not found: " + cfg.s3genModelPath);
  }
  if (!cfg.referenceAudio.empty() &&
      !std::filesystem::exists(cfg.referenceAudio)) {
    throw createTTSError(TTSErrorCode::ModelFileNotFound, "reference audio not found: " + cfg.referenceAudio);
  }
  if (!cfg.voiceDir.empty() && !std::filesystem::is_directory(cfg.voiceDir)) {
    throw createTTSError(TTSErrorCode::ModelFileNotFound, "voice dir not found: " + cfg.voiceDir);
  }
}

void ChatterboxModel::load() {
  // Nothing to pre-load in v0: each process() call spins up its own model.
  // This hook exists so the follow-up persistent-engine milestone can drop
  // in without breaking the AddonCpp::activate() contract.
  loaded_ = true;
}

void ChatterboxModel::unload() { loaded_ = false; }

void ChatterboxModel::reload() { loaded_ = true; }

void ChatterboxModel::cancel() const {
  cancelRequested_.store(true, std::memory_order_relaxed);
}

ChatterboxModel::Output ChatterboxModel::synthesize(
    const std::string& text, const JobConfig& overrides) {
  const auto tStart = std::chrono::steady_clock::now();

  if (cancelRequested_.load(std::memory_order_relaxed)) {
    throw createTTSError(TTSErrorCode::SynthesisFailed, "synthesis cancelled before it started");
  }

  const auto outPath = makeScratchWavPath();

  ArgvBuilder args;
  args.add("qvac-tts");
  args.add("--model");
  args.add(cfg_.t3ModelPath);
  args.add("--s3gen-gguf");
  args.add(cfg_.s3genModelPath);
  args.add("--text");
  args.add(text);
  args.add("--out");
  args.add(outPath.string());

  if (cfg_.seed.has_value()) {
    args.add("--seed");
    args.add(std::to_string(*cfg_.seed));
  }
  if (cfg_.threads.has_value()) {
    args.add("--threads");
    args.add(std::to_string(*cfg_.threads));
  }
  if (cfg_.nGpuLayers.has_value()) {
    args.add("--n-gpu-layers");
    args.add(std::to_string(*cfg_.nGpuLayers));
  } else if (cfg_.useGpu) {
    args.add("--n-gpu-layers");
    args.add("99");
  }
  if (!cfg_.referenceAudio.empty()) {
    args.add("--reference-audio");
    args.add(cfg_.referenceAudio);
  }
  if (!cfg_.voiceDir.empty()) {
    args.add("--ref-dir");
    args.add(cfg_.voiceDir);
  }

  auto [argv, argc] = args.buildArgv();

  int rc = 0;
  try {
    rc = qvac_tts_cli_main(argc, argv);
  } catch (const std::exception& e) {
    std::error_code ec;
    std::filesystem::remove(outPath, ec);
    throw createTTSError(TTSErrorCode::SynthesisFailed, std::string("qvac_tts_cli_main threw: ") + e.what());
  }

  if (rc != 0) {
    std::error_code ec;
    std::filesystem::remove(outPath, ec);
    throw createTTSError(TTSErrorCode::SynthesisFailed, "qvac_tts_cli_main exited with code " + std::to_string(rc));
  }

  int sampleRate = 0;
  std::vector<int16_t> pcm;
  try {
    pcm = readPcm16Wav(outPath, sampleRate);
  } catch (...) {
    std::error_code ec;
    std::filesystem::remove(outPath, ec);
    throw;
  }
  std::error_code ec;
  std::filesystem::remove(outPath, ec);

  const auto tEnd = std::chrono::steady_clock::now();
  const double elapsedSec =
      std::chrono::duration<double>(tEnd - tStart).count();

  totalTime_ = elapsedSec;
  totalSamples_ = static_cast<int64_t>(pcm.size());
  audioDurationMs_ =
      sampleRate > 0 ? (static_cast<double>(pcm.size()) * 1000.0 /
                        static_cast<double>(sampleRate))
                     : 0.0;
  realTimeFactor_ =
      audioDurationMs_ > 0 ? (elapsedSec * 1000.0) / audioDurationMs_ : 0.0;
  textLength_ = text.size();
  tokensPerSecond_ =
      elapsedSec > 0 ? static_cast<double>(textLength_) / elapsedSec : 0.0;

  // `overrides` reserved for per-request tweaks (e.g. per-request
  // outputSampleRate resampling, which we'll wire in once the CLI gains that
  // flag or we move off qvac_tts_cli_main entirely).
  (void)overrides;

  return pcm;
}

std::any ChatterboxModel::process(const std::any& input) {
  const auto* anyInput = std::any_cast<AnyInput>(&input);
  if (anyInput == nullptr) {
    throw createTTSError(TTSErrorCode::SynthesisFailed, "ChatterboxModel::process: expected AnyInput (text + config)");
  }
  if (anyInput->text.empty()) {
    throw createTTSError(TTSErrorCode::SynthesisFailed, "ChatterboxModel::process: empty text");
  }
  cancelRequested_.store(false, std::memory_order_relaxed);
  return std::any(synthesize(anyInput->text, anyInput->config));
}

qvac_lib_inference_addon_cpp::RuntimeStats ChatterboxModel::runtimeStats() const {
  qvac_lib_inference_addon_cpp::RuntimeStats stats;
  stats.emplace_back("totalTime", totalTime_);
  stats.emplace_back("tokensPerSecond", tokensPerSecond_);
  stats.emplace_back("realTimeFactor", realTimeFactor_);
  stats.emplace_back("audioDurationMs", audioDurationMs_);
  stats.emplace_back("totalSamples", totalSamples_);
  return stats;
}

} // namespace qvac::ttsggml::chatterbox
