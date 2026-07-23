#include "ParakeetModel.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iomanip>
#include <ios>
#include <random>
#include <sstream>
#include <stdexcept>
#include <vector>

#include <parakeet/parakeet.h>

#include "ggml-backend.h"
#include "ggml.h"
#include "inference-addon-cpp/Errors.hpp"
#include "inference-addon-cpp/Logger.hpp"

namespace qvac_lib_infer_parakeet {

namespace fs = std::filesystem;
using namespace qvac_lib_inference_addon_cpp;

namespace {

// backendId family codes surfaced on JS as `RuntimeStats.backendId`; kept
// in sync with index.d.ts. Device classes for backend_device_ / getBackend
// DeviceClass().
enum BackendId {
  BackendCpu = 0,
  BackendMetal = 1,
  BackendCuda = 2,
  BackendVulkan = 3,
  BackendOpenCl = 4,
  BackendOther = 99
};
enum BackendDeviceClass { DeviceCpu = 0, DeviceGpu = 1 };

// n_gpu_layers value that offloads every layer to the GPU backend.
constexpr int OFFLOAD_ALL_LAYERS_TO_GPU = 999;

// Match by prefix: ggml_backend_name() returns indexed strings like "CUDA0"
// / "Vulkan0" / "MTL0" on multi-GPU hosts. Metal reports as "MTL0" from
// ggml despite parakeet advertising "Metal", so accept both forms.
int backendIdFromName(const std::string& name) {
  if (name == "CPU")
    return BackendCpu;
  if (name.rfind("Metal", 0) == 0 || name.rfind("MTL", 0) == 0)
    return BackendMetal;
  if (name.rfind("CUDA", 0) == 0)
    return BackendCuda;
  if (name.rfind("Vulkan", 0) == 0)
    return BackendVulkan;
  if (name.rfind("OpenCL", 0) == 0)
    return BackendOpenCl;
  return BackendOther;
}

// Maps a ggml backend *registry* name to the same family code so the engine's
// device can be matched against the ggml device registry for its description.
int backendIdFromRegName(std::string regName) {
  std::transform(
      regName.begin(), regName.end(), regName.begin(), [](unsigned char c) {
        return std::tolower(c);
      });
  if (regName.rfind("metal", 0) == 0)
    return BackendMetal;
  if (regName.rfind("cuda", 0) == 0)
    return BackendCuda;
  if (regName.rfind("vulkan", 0) == 0)
    return BackendVulkan;
  if (regName.rfind("opencl", 0) == 0)
    return BackendOpenCl;
  return BackendOther;
}

bool isGpuDevice(ggml_backend_dev_t dev) {
  const enum ggml_backend_dev_type type = ggml_backend_dev_type(dev);
  return type == GGML_BACKEND_DEVICE_TYPE_GPU ||
         type == GGML_BACKEND_DEVICE_TYPE_IGPU;
}

std::string deviceDescriptionOrName(ggml_backend_dev_t dev) {
  const char* desc = ggml_backend_dev_description(dev);
  if (desc != nullptr && desc[0] != '\0')
    return desc;
  const char* name = ggml_backend_dev_name(dev);
  return (name != nullptr) ? name : "";
}

int backendIdOfDevice(ggml_backend_dev_t dev) {
  ggml_backend_reg_t reg = ggml_backend_dev_backend_reg(dev);
  const char* regName = (reg != nullptr) ? ggml_backend_reg_name(reg) : "";
  return backendIdFromRegName(regName != nullptr ? regName : "");
}

// Finds the ggml GPU device whose backend family matches backendId, setting
// firstGpuOut to the first GPU device seen as a fallback.
ggml_backend_dev_t
findGpuDeviceForBackend(int backendId, ggml_backend_dev_t& firstGpuOut) {
  firstGpuOut = nullptr;
  const size_t devCount = ggml_backend_dev_count();
  for (size_t i = 0; i < devCount; ++i) {
    ggml_backend_dev_t dev = ggml_backend_dev_get(i);
    if (dev == nullptr || !isGpuDevice(dev))
      continue;
    if (firstGpuOut == nullptr)
      firstGpuOut = dev;
    if (backendIdOfDevice(dev) == backendId)
      return dev;
  }
  return nullptr;
}

// Human-readable GPU device name recovered from the ggml device registry;
// "" on CPU or when no GPU is registered. Prefers the device whose backend
// family matches the engine, else the first GPU/IGPU device.
std::string captureBackendDescription(int backendId, int backendDevice) {
  if (backendDevice != DeviceGpu)
    return "";
  ggml_backend_dev_t firstGpu = nullptr;
  ggml_backend_dev_t matched = findGpuDeviceForBackend(backendId, firstGpu);
  if (matched != nullptr)
    return deviceDescriptionOrName(matched);
  if (firstGpu != nullptr)
    return deviceDescriptionOrName(firstGpu);
  return "";
}

// HH:MM:SS.fff for Sortformer speaker-segment formatting
std::string formatSeconds(float seconds) {
  if (seconds < 0.0f) seconds = 0.0f;
  const int    hours = static_cast<int>(seconds) / 3600;
  const int    mins  = (static_cast<int>(seconds) / 60) % 60;
  const float  secs  = seconds - (hours * 3600 + mins * 60);
  std::ostringstream os;
  os << std::setfill('0') << std::setw(2) << hours << ":"
     << std::setfill('0') << std::setw(2) << mins  << ":"
     << std::fixed << std::setprecision(3)
     << std::setfill('0') << std::setw(6) << secs;
  return os.str();
}

template <typename Fn>
int64_t measureMs(Fn&& fn) {
  const auto t0 = std::chrono::steady_clock::now();
  fn();
  const auto t1 = std::chrono::steady_clock::now();
  return std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();
}

// Routes ggml's stderr logging through the binding's QLOG() pipe so it obeys
// --native-logs (or stays silent by default). Multi-part CONT lines are
// buffered and flushed together so QLOG sees one logical line per ggml line.

std::mutex& ggmlLogBufMutex() {
  static std::mutex m;
  return m;
}
std::string& ggmlLogBuf() {
  static std::string buf;
  return buf;
}
ggml_log_level& ggmlLogBufLevel() {
  static ggml_log_level lvl = GGML_LOG_LEVEL_INFO;
  return lvl;
}

logger::Priority ggmlLevelToPriority(ggml_log_level level) {
  switch (level) {
    case GGML_LOG_LEVEL_ERROR: return logger::Priority::ERROR;
    case GGML_LOG_LEVEL_WARN:  return logger::Priority::WARNING;
    case GGML_LOG_LEVEL_DEBUG: return logger::Priority::DEBUG;
    case GGML_LOG_LEVEL_INFO:
    case GGML_LOG_LEVEL_CONT:
    default:                   return logger::Priority::INFO;
  }
}

void flushCompleteLogLines() {
  for (size_t nl = ggmlLogBuf().find('\n'); nl != std::string::npos;
       nl = ggmlLogBuf().find('\n')) {
    std::string line = ggmlLogBuf().substr(0, nl);
    ggmlLogBuf().erase(0, nl + 1);
    if (line.empty()) continue;
    QLOG(ggmlLevelToPriority(ggmlLogBufLevel()), line);
  }
}

void ggmlLogTrampoline(
    ggml_log_level level, const char* text, void* /*user_data*/) {
  if (!text)
    return;
  std::lock_guard<std::mutex> lk(ggmlLogBufMutex());
  if (level != GGML_LOG_LEVEL_CONT)
    ggmlLogBufLevel() = level;
  ggmlLogBuf().append(text);
  flushCompleteLogLines();
}

void installGgmlLogTrampolineOnce() {
  static std::once_flag once;
  std::call_once(once, [] {
    ggml_log_set(&ggmlLogTrampoline, nullptr);
  });
}

constexpr float PCM_S16_SCALE = 1.0F / 32768.0F;

float pcmS16ToFloat32(int16_t sample) {
  return static_cast<float>(sample) * PCM_S16_SCALE;
}

int16_t readLittleEndianS16(uint8_t lo, uint8_t hi) {
  return static_cast<int16_t>(lo | (hi << 8));
}

std::vector<float> decodeS16lePcm(const std::vector<uint8_t>& bytes) {
  const size_t nSamples = bytes.size() / 2;
  std::vector<float> out(nSamples);
  for (size_t i = 0; i < nSamples; ++i) {
    out[i] =
        pcmS16ToFloat32(readLittleEndianS16(bytes[i * 2], bytes[i * 2 + 1]));
  }
  return out;
}

std::string formatSpeakerSegment(int speakerId, double startS, double endS) {
  std::ostringstream os;
  os << "Speaker " << speakerId << ": "
     << formatSeconds(static_cast<float>(startS)) << " - "
     << formatSeconds(static_cast<float>(endS));
  return os.str();
}

template <typename Segments>
std::string formatDiarizationSegments(const Segments& segments) {
  std::ostringstream os;
  bool first = true;
  for (const auto& s : segments) {
    if (!first)
      os << "\n";
    first = false;
    os << formatSpeakerSegment(s.speaker_id, s.start_s, s.end_s);
  }
  return os.str();
}

Transcript
makeDiarizationTranscript(const parakeet::StreamingDiarizationSegment& seg) {
  Transcript t;
  t.text = formatSpeakerSegment(seg.speaker_id, seg.start_s, seg.end_s);
  t.start = static_cast<float>(seg.start_s);
  t.end = static_cast<float>(seg.end_s);
  t.toAppend = true;
  return t;
}

Transcript makeAsrTranscript(const parakeet::StreamingSegment& seg) {
  Transcript t;
  t.text = seg.text;
  t.start = static_cast<float>(seg.start_s);
  t.end = static_cast<float>(seg.end_s);
  t.toAppend = true;
  t.isEndOfTurn = seg.is_eou_boundary;
  t.startsWord = seg.starts_word;
  return t;
}

std::string joinTranscriptText(
    const std::vector<Transcript>& segments, const char* separator) {
  std::ostringstream os;
  for (size_t i = 0; i < segments.size(); ++i) {
    if (i > 0)
      os << separator;
    os << segments[i].text;
  }
  return os.str();
}

parakeet::EngineOptions
buildEngineOptions(const ParakeetConfig& cfg, const fs::path& ggufPath) {
  parakeet::EngineOptions eopts;
  eopts.model_gguf_path = ggufPath.string();
  // n_threads = 0 lets ggml pick hardware_concurrency; maxThreads is honoured
  // only when explicitly set non-zero.
  eopts.n_threads = cfg.maxThreads > 0 ? cfg.maxThreads : 0;
  eopts.n_gpu_layers = cfg.useGPU ? OFFLOAD_ALL_LAYERS_TO_GPU : 0;
  eopts.verbose = false;
  // Compose the backends-scan dir from the host prebuilds root plus the
  // cmake-bare per-target subdir (BACKENDS_SUBDIR). Empty -> ggml's default
  // compile-time search path.
  if (!cfg.backendsDir.empty()) {
    fs::path backendsDirPath(cfg.backendsDir);
#ifdef BACKENDS_SUBDIR
    backendsDirPath =
        (backendsDirPath / fs::path(BACKENDS_SUBDIR)).lexically_normal();
#endif
    eopts.backends_dir = backendsDirPath.string();
  }
  // Empty -> leave $GGML_OPENCL_CACHE_DIR alone (Android-only, read once).
  eopts.opencl_cache_dir = cfg.openclCacheDir;
  return eopts;
}

parakeet::SortformerStreamingOptions buildSortformerStreamingOptions(
    const ParakeetConfig& cfg, int sampleRate, float onset,
    float minDurationOn) {
  parakeet::SortformerStreamingOptions opts;
  opts.sample_rate = sampleRate;
  opts.chunk_ms = cfg.streamingChunkMs > 0
                      ? cfg.streamingChunkMs
                      : ParakeetConfig::DEFAULT_STREAMING_CHUNK_MS;
  opts.history_ms = cfg.streamingHistoryMs > 0
                        ? cfg.streamingHistoryMs
                        : ParakeetConfig::DEFAULT_STREAMING_HISTORY_MS;
  opts.threshold = onset;
  opts.min_segment_ms = static_cast<int>(minDurationOn * 1000.0F);
  opts.emit_partials = cfg.streamingEmitPartials;
  // AOSC (v2.1+ Sortformer only); parakeet-cpp ignores it on v1/v2 GGUFs.
  opts.spkcache_enable = cfg.streamingSpkCacheEnable;
  opts.spkcache_len = cfg.streamingSpkCacheLen;
  opts.fifo_len = cfg.streamingFifoLen;
  opts.chunk_left_context_ms = cfg.streamingChunkLeftContextMs;
  opts.chunk_right_context_ms = cfg.streamingChunkRightContextMs;
  opts.spkcache_update_period = cfg.streamingSpkCacheUpdatePeriod;
  return opts;
}

parakeet::StreamingOptions
buildAsrStreamingOptions(const ParakeetConfig& cfg, int sampleRate) {
  parakeet::StreamingOptions opts;
  opts.sample_rate = sampleRate;
  opts.chunk_ms = cfg.streamingChunkMs > 0
                      ? cfg.streamingChunkMs
                      : ParakeetConfig::DEFAULT_STREAMING_CHUNK_MS;
  if (cfg.streamingLeftContextMs > 0) {
    opts.left_context_ms = cfg.streamingLeftContextMs;
  }
  if (cfg.streamingRightLookaheadMs >= 0) {
    opts.right_lookahead_ms = cfg.streamingRightLookaheadMs;
  }
  opts.emit_partials = cfg.streamingEmitPartials;
  opts.enable_energy_vad = cfg.streamingEnergyVad;
  return opts;
}

} // namespace

ParakeetModel::ParakeetModel(const ParakeetConfig& config) : cfg_(config) {
  if (cfg_.sampleRate != 0) {
    sample_rate_ = cfg_.sampleRate;
  }
}

ParakeetModel::~ParakeetModel() {
  try {
    unload();
  } catch (...) {
  }
}

void ParakeetModel::initializeBackend() {
  // Engine's constructor selects the ggml backend; here we only route ggml's
  // own log lines through QLOG() so they obey --native-logs.
  installGgmlLogTrampolineOnce();
}

std::filesystem::path ParakeetModel::writeBufferToTempFile() {
  if (gguf_buffer_.empty()) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "ParakeetModel::load: no GGUF bytes received before load()");
  }

  // Per-process unique temp filename (std::tmpnam is racy/deprecated) so
  // multiple ParakeetModel instances in one process don't collide.
  const auto pid = static_cast<unsigned long>(std::random_device{}());
  const auto when = std::chrono::steady_clock::now().time_since_epoch().count();
  std::ostringstream name;
  name << "qvac-parakeet-" << pid << "-" << when << ".gguf";

  fs::path tmpDir;
  try {
    tmpDir = fs::temp_directory_path();
  } catch (...) {
    tmpDir = "/tmp";
  }
  fs::path out = tmpDir / name.str();

  std::ofstream f(out, std::ios::binary);
  if (!f) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InternalError,
        std::string("ParakeetModel::load: cannot open temp GGUF file ") +
            out.string());
  }
  f.write(reinterpret_cast<const char*>(gguf_buffer_.data()),
          static_cast<std::streamsize>(gguf_buffer_.size()));
  if (!f) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InternalError,
        std::string("ParakeetModel::load: failed writing GGUF to ") +
            out.string());
  }
  f.close();
  return out;
}

void ParakeetModel::cleanupTempFile() {
  if (!gguf_temp_path_.empty()) {
    std::error_code ec;
    fs::remove(gguf_temp_path_, ec);
    gguf_temp_path_.clear();
  }
}

std::filesystem::path ParakeetModel::resolveGgufPath() {
  // Prefer an existing cfg_.modelPath (skips the temp-file copy); otherwise
  // materialise streamed setWeightsForFile() bytes into a temp file.
  if (!cfg_.modelPath.empty() && fs::exists(cfg_.modelPath)) {
    return cfg_.modelPath;
  }
  if (gguf_completed_ && !gguf_buffer_.empty()) {
    gguf_temp_path_ = writeBufferToTempFile();
    return gguf_temp_path_;
  }
  throw qvac_errors::StatusError(
      qvac_errors::general_error::InvalidArgument,
      "ParakeetModel::load: no GGUF available "
      "(no setWeightsForFile() bytes and modelPath is missing or empty)");
}

void ParakeetModel::detectModelType() {
  if (!engine_)
    return;
  // The engine reports `parakeet.model.type` from GGUF metadata, so callers
  // don't pass modelType; keep cfg_.modelType only if it's unrecognised.
  const std::string detected = engine_->model_type();
  if (detected == "ctc")
    cfg_.modelType = ModelType::CTC;
  else if (detected == "tdt")
    cfg_.modelType = ModelType::TDT;
  else if (detected == "eou")
    cfg_.modelType = ModelType::EOU;
  else if (detected == "sortformer")
    cfg_.modelType = ModelType::SORTFORMER;
}

void ParakeetModel::captureBackend() {
  if (!engine_)
    return;
  backend_device_ = engine_->backend_device() == parakeet::BackendDevice::GPU
                        ? DeviceGpu
                        : DeviceCpu;
  backend_name_ = engine_->backend_name();
  backend_id_ = backendIdFromName(backend_name_);
  backend_gpu_unsupported_ = engine_->gpu_unsupported() ? 1 : 0;
  backend_description_ =
      captureBackendDescription(backend_id_, backend_device_);

  QLOG(
      logger::Priority::INFO,
      std::string("Parakeet engine loaded; model_type=") +
          engine_->model_type() + " backend=" + backend_name_ +
          " (device=" + (backend_device_ == DeviceGpu ? "GPU" : "CPU") +
          ", id=" + std::to_string(backend_id_) + ", gpu='" +
          backend_description_ + "')");
}

void ParakeetModel::warnOnGpuFallback() const {
  if (cfg_.useGPU && backend_device_ != DeviceGpu &&
      !backend_gpu_unsupported_) {
    QLOG(
        logger::Priority::WARNING,
        "Parakeet: useGPU=true was requested but the active backend is CPU. "
        "The platform's GPU backend either isn't compiled in or refused to "
        "initialise (e.g. missing OpenCL ICD, Adreno-tier policy, simulator "
        "without Metal). Falling back to CPU.");
  }
}

void ParakeetModel::openStreamingSessionOrThrow() {
  try {
    openStreamingSession();
  } catch (const std::exception& e) {
    QLOG(
        logger::Priority::ERROR,
        std::string("Failed to open streaming session: ") + e.what());
    throw;
  }
}

void ParakeetModel::warnOnSampleRateMismatch() const {
  // The engine's mel preprocessor is hardcoded to 16 kHz, so warn if the
  // caller asked for anything else.
  if (sample_rate_ != static_cast<int>(SAMPLE_RATE)) {
    QLOG(
        logger::Priority::WARNING,
        "Parakeet engine assumes 16 kHz audio; cfg.sampleRate=" +
            std::to_string(sample_rate_) +
            " will be ignored at the engine boundary");
  }
}

void ParakeetModel::load() {
  if (is_loaded_) return;

  QLOG(logger::Priority::INFO,
       "Loading Parakeet GGUF (modelType hint: " +
           std::to_string(static_cast<int>(cfg_.modelType)) + ")");

  modelLoadMs_ = measureMs([&] {
    const fs::path ggufPath = resolveGgufPath();
    installGgmlLogTrampolineOnce();
    const parakeet::EngineOptions eopts = buildEngineOptions(cfg_, ggufPath);
    std::lock_guard<std::mutex> lk(engine_mutex_);
    engine_ = std::make_unique<parakeet::Engine>(eopts);
  });

  is_loaded_ = true;
  detectModelType();
  captureBackend();
  warnOnGpuFallback();

  if (cfg_.streaming) {
    openStreamingSessionOrThrow();
  }

  warnOnSampleRateMismatch();

  gguf_buffer_.clear();
  gguf_buffer_.shrink_to_fit();

  QLOG(logger::Priority::INFO,
       "Parakeet engine loaded in " + std::to_string(modelLoadMs_) + "ms");
}

void ParakeetModel::unload() {
  closeStreamingSession();
  {
    std::lock_guard<std::mutex> lk(engine_mutex_);
    engine_.reset();
  }
  is_loaded_     = false;
  is_warmed_up_  = false;
  cleanupTempFile();
}

void ParakeetModel::reload() {
  // Requires a persistent modelPath: unload() drops the in-memory GGUF
  // buffer, so a stream-only load has nothing to re-open.
  if (cfg_.modelPath.empty()) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InternalError,
        "ParakeetModel::reload requires a persistent modelPath; "
        "in-memory GGUF buffer is dropped on unload()");
  }
  unload();
  load();
}

void ParakeetModel::endOfStream() {
  stream_ended_ = true;
  if (!cfg_.streaming || streaming_finalized_) return;
  parakeet::StreamSession*           asr  = nullptr;
  parakeet::SortformerStreamSession* diar = nullptr;
  {
    std::lock_guard<std::mutex> lk(session_mutex_);
    asr  = asr_session_.get();
    diar = diar_session_.get();
  }
  try {
    if (asr)  asr->finalize();
    if (diar) diar->finalize();
  } catch (const std::exception& e) {
    QLOG(logger::Priority::WARNING,
         std::string("Streaming session finalize failed: ") + e.what());
  }
  streaming_finalized_ = true;

  // Surface segments emitted by finalize() so the trailing partial chunk
  // reaches the next process() return.
  emitStreamingSegments(takePendingStreamingSegments());
}

void ParakeetModel::reset() {
  output_.clear();
  stream_ended_   = false;
  processed_time_ = 0.0f;
  cancelGeneration_.store(0, std::memory_order_relaxed);
  activeGeneration_.store(0, std::memory_order_relaxed);
}

void ParakeetModel::warmup() {
  if (is_warmed_up_ || !is_loaded_) return;
  Input silence(static_cast<size_t>(SAMPLE_RATE), 0.0f);
  try {
    runAsrProcess(silence);
  } catch (...) {
  }
  output_.clear();
  is_warmed_up_ = true;
}

void ParakeetModel::throwIfCancelled() const {
  const auto active = activeGeneration_.load(std::memory_order_relaxed);
  const auto cancel = cancelGeneration_.load(std::memory_order_relaxed);
  if (active != 0 && cancel >= active) {
    // The framework has no OperationCanceled code, so raise InternalError
    // with ERR_JOB_CANCELLED text that isCancellationError() recognises.
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InternalError, ERR_JOB_CANCELLED);
  }
}

bool ParakeetModel::isCancellationError(const std::exception& e) {
  const std::string what = e.what();
  return what.find(ERR_JOB_CANCELLED) != std::string::npos;
}

void ParakeetModel::cancel() const {
  const auto active = activeGeneration_.load(std::memory_order_relaxed);
  cancelGeneration_.store(active, std::memory_order_relaxed);
  // cancel() may race with the open/close/unload lifecycle, so snapshot the
  // session pointers under session_mutex_ and invoke the engine's own
  // (thread-safe) cancel() outside the lock.
  parakeet::StreamSession*           asr  = nullptr;
  parakeet::SortformerStreamSession* diar = nullptr;
  {
    std::lock_guard<std::mutex> lk(session_mutex_);
    asr  = asr_session_.get();
    diar = diar_session_.get();
  }
  if (asr)  { try { asr->cancel();  } catch (...) {} }
  if (diar) { try { diar->cancel(); } catch (...) {} }
}

void ParakeetModel::set_weights_for_file(const std::string& filename,
                                         std::span<const uint8_t> contents,
                                         bool completed) {
  // Only a single GGUF is accepted; other extensions are rejected.
  const std::string lower = [&] {
    std::string s = filename;
    std::transform(s.begin(), s.end(), s.begin(), ::tolower);
    return s;
  }();
  const bool isGguf =
      lower.size() >= 5 && lower.compare(lower.size() - 5, 5, ".gguf") == 0;
  if (!isGguf) {
    QLOG(logger::Priority::WARNING,
         "Parakeet ggml backend ignores non-GGUF weight file '" + filename + "'");
    if (completed) gguf_completed_ = true;
    return;
  }

  if (gguf_filename_.empty()) {
    gguf_filename_ = filename;
  }

  if (!contents.empty()) {
    gguf_buffer_.insert(gguf_buffer_.end(), contents.begin(), contents.end());
  }
  if (completed) gguf_completed_ = true;
}

void ParakeetModel::set_weights_for_file(
    const std::string& filename,
    std::unique_ptr<std::basic_streambuf<char>> streambuf) {
  if (!streambuf) return;
  // Drain via sgetn in fixed chunks (not all streambufs support seekg/tellg).
  std::vector<uint8_t> buf;
  std::array<char, 64 * 1024> tmp{};
  while (true) {
    const std::streamsize got = streambuf->sgetn(tmp.data(),
                                                 static_cast<std::streamsize>(tmp.size()));
    if (got <= 0) break;
    buf.insert(buf.end(),
               reinterpret_cast<const uint8_t *>(tmp.data()),
               reinterpret_cast<const uint8_t *>(tmp.data()) + got);
    if (got < static_cast<std::streamsize>(tmp.size())) break;
  }
  set_weights_for_file(filename,
                       std::span<const uint8_t>(buf.data(), buf.size()),
                       /*completed=*/true);
}

void ParakeetModel::setWeightsForFile(
    const std::string& filename,
    std::unique_ptr<std::basic_streambuf<char>>&& streambuf) {
  set_weights_for_file(filename, std::move(streambuf));
}

std::vector<float>
ParakeetModel::preprocessAudioData(const std::vector<uint8_t>& audioData,
                                   const std::string& audioFormat) {
  if (audioFormat != "s16le") {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "ParakeetModel::preprocessAudioData: only s16le PCM is supported");
  }
  return decodeS16lePcm(audioData);
}

std::string ParakeetModel::runAsrProcess(const Input& input) {
  if (input.empty()) return ERR_AUDIO_SHORT;

  parakeet::Engine* engine = nullptr;
  {
    std::lock_guard<std::mutex> lk(engine_mutex_);
    engine = engine_.get();
  }
  if (!engine) return ERR_MODEL_NOT_LOADED;

  parakeet::EngineResult result =
      engine->transcribe_samples(input.data(),
                                 static_cast<int>(input.size()),
                                 sample_rate_);
  // Record per-stage timings verbatim; engines that don't report a stage
  // record 0 rather than mis-attributing wall-clock across buckets.
  encoderMs_         += static_cast<int64_t>(result.encoder_ms);
  decoderMs_         += static_cast<int64_t>(result.decode_ms);
  melSpecMs_         += static_cast<int64_t>(result.preprocess_ms);
  totalEncodedFrames_+= result.encoder_frames;
  totalTokens_       += static_cast<int64_t>(result.token_ids.size());

  if (result.text.empty()) return ERR_NO_SPEECH;
  return result.text;
}

std::string ParakeetModel::runSortformerProcess(const Input& input) {
  if (input.empty()) return ERR_AUDIO_SHORT;

  parakeet::Engine* engine = nullptr;
  {
    std::lock_guard<std::mutex> lk(engine_mutex_);
    engine = engine_.get();
  }
  if (!engine) return ERR_MODEL_NOT_LOADED;

  parakeet::DiarizationOptions dopts;
  dopts.threshold      = diarConfig_.onset;
  dopts.min_segment_ms = static_cast<int>(diarConfig_.minDurationOn * 1000.0f);

  parakeet::DiarizationResult diar;
  encoderMs_ += measureMs([&] {
    diar = engine->diarize_samples(input.data(),
                                   static_cast<int>(input.size()),
                                   sample_rate_, dopts);
  });

  if (diar.segments.empty()) return ERR_NO_SPEAKERS;

  return formatDiarizationSegments(diar.segments);
}

std::unique_ptr<parakeet::StreamSession> ParakeetModel::createDuplexAsrSession(
    const parakeet::StreamingOptions& opts,
    parakeet::StreamingCallback onSegment) {
  parakeet::Engine* engine = nullptr;
  {
    std::lock_guard<std::mutex> lk(engine_mutex_);
    engine = engine_.get();
  }
  if (!engine) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InternalError,
        "ParakeetModel::createDuplexAsrSession: engine not loaded");
  }
  return engine->stream_start(opts, std::move(onSegment));
}

std::unique_ptr<parakeet::SortformerStreamSession>
ParakeetModel::createDuplexDiarizationSession(
    const parakeet::SortformerStreamingOptions& opts,
    parakeet::SortformerSegmentCallback onSegment) {
  parakeet::Engine* engine = nullptr;
  {
    std::lock_guard<std::mutex> lk(engine_mutex_);
    engine = engine_.get();
  }
  if (!engine) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InternalError,
        "ParakeetModel::createDuplexDiarizationSession: engine not loaded");
  }
  return engine->diarize_start(opts, std::move(onSegment));
}

void ParakeetModel::openStreamingSession() {
  parakeet::Engine* engine = nullptr;
  {
    std::lock_guard<std::mutex> lk(engine_mutex_);
    engine = engine_.get();
  }
  if (!engine) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InternalError,
        "ParakeetModel::openStreamingSession: engine not loaded");
  }

  streaming_audio_seconds_ = 0.0;
  streaming_finalized_     = false;
  {
    std::lock_guard<std::mutex> lk(streaming_mutex_);
    pending_streaming_segments_.clear();
  }

  if (cfg_.modelType == ModelType::SORTFORMER) {
    openSortformerStreamingSession(*engine);
  } else {
    openAsrStreamingSession(*engine);
  }
}

void ParakeetModel::openSortformerStreamingSession(parakeet::Engine& engine) {
  const parakeet::SortformerStreamingOptions opts =
      buildSortformerStreamingOptions(
          cfg_, sample_rate_, diarConfig_.onset, diarConfig_.minDurationOn);
  auto session = engine.diarize_start(
      opts, [this](const parakeet::StreamingDiarizationSegment& seg) {
        // Negative speaker_id is the synthetic finalize terminator.
        if (seg.speaker_id < 0)
          return;
        pushPendingSegment(makeDiarizationTranscript(seg));
      });
  std::lock_guard<std::mutex> lk(session_mutex_);
  diar_session_ = std::move(session);
}

void ParakeetModel::openAsrStreamingSession(parakeet::Engine& engine) {
  if (cfg_.streamingHistoryMs > 0) {
    QLOG(
        logger::Priority::WARNING,
        "streamingHistoryMs is Sortformer-only and is ignored for ASR "
        "streaming sessions");
  }
  const parakeet::StreamingOptions opts =
      buildAsrStreamingOptions(cfg_, sample_rate_);
  auto session =
      engine.stream_start(opts, [this](const parakeet::StreamingSegment& seg) {
        if (seg.text.empty() && !seg.is_eou_boundary)
          return;
        pushPendingSegment(makeAsrTranscript(seg));
      });
  std::lock_guard<std::mutex> lk(session_mutex_);
  asr_session_ = std::move(session);
}

void ParakeetModel::pushPendingSegment(Transcript segment) {
  std::lock_guard<std::mutex> lk(streaming_mutex_);
  pending_streaming_segments_.push_back(std::move(segment));
}

std::vector<Transcript> ParakeetModel::takePendingStreamingSegments() {
  std::vector<Transcript> drained;
  std::lock_guard<std::mutex> lk(streaming_mutex_);
  drained.swap(pending_streaming_segments_);
  return drained;
}

void ParakeetModel::emitStreamingSegments(
    const std::vector<Transcript>& segments) {
  for (const auto& seg : segments) {
    output_.push_back(seg);
    if (on_segment_)
      on_segment_(seg);
    ++totalTranscriptions_;
  }
}

void ParakeetModel::closeStreamingSession() {
  // Take ownership of the sessions under session_mutex_ so a concurrent
  // cancel() can't see a half-destroyed session, then destroy outside it.
  std::unique_ptr<parakeet::StreamSession> asrToDestroy;
  std::unique_ptr<parakeet::SortformerStreamSession> diarToDestroy;
  {
    std::lock_guard<std::mutex> lk(session_mutex_);
    asrToDestroy = std::move(asr_session_);
    diarToDestroy = std::move(diar_session_);
  }
  if (asrToDestroy) {
    try {
      asrToDestroy->cancel();
    } catch (...) {
    }
  }
  if (diarToDestroy) {
    try {
      diarToDestroy->cancel();
    } catch (...) {
    }
  }
  asrToDestroy.reset();
  diarToDestroy.reset();
  {
    std::lock_guard<std::mutex> lk(streaming_mutex_);
    pending_streaming_segments_.clear();
  }
  streaming_audio_seconds_ = 0.0;
  streaming_finalized_     = false;
}

int64_t ParakeetModel::feedStreamingChunk(const Input& input) {
  // Feed the batch then finalize so flush_remainder() drains the trailing
  // right_lookahead window (otherwise the terminal <EOU> never surfaces).
  return measureMs([&] {
    if (cfg_.modelType == ModelType::SORTFORMER) {
      if (diar_session_) {
        diar_session_->feed_pcm_f32(input.data(),
                                    static_cast<int>(input.size()));
        try {
          diar_session_->finalize();
        } catch (...) {
        }
      }
    } else {
      if (asr_session_) {
        asr_session_->feed_pcm_f32(input.data(),
                                   static_cast<int>(input.size()));
        try {
          asr_session_->finalize();
        } catch (...) {
        }
      }
    }
  });
}

void ParakeetModel::reopenStreamingSession() {
  // Each framework-path run() is an independent utterance, so the finalized
  // session is closed and reopened. This WIPES engine-side cross-chunk state
  // (Sortformer speaker history, EOU window); "preserves state across
  // appends" holds only within a single run(). Use runStreaming() for a
  // long-lived session.
  closeStreamingSession();
  try {
    openStreamingSession();
  } catch (const std::exception& e) {
    QLOG(logger::Priority::WARNING,
         std::string("Failed to reopen streaming session: ") + e.what());
  }
}

std::string ParakeetModel::runStreamingProcess(const Input& input) {
  if (input.empty())
    return ERR_AUDIO_SHORT;
  if (streaming_finalized_) {
    QLOG(
        logger::Priority::WARNING,
        "process() called after streaming session was finalized; ignoring");
    return std::string();
  }

  encoderMs_ += feedStreamingChunk(input);
  streaming_audio_seconds_ +=
      static_cast<double>(input.size()) / static_cast<double>(sample_rate_);

  std::vector<Transcript> drained = takePendingStreamingSegments();
  if (drained.empty()) {
    return cfg_.modelType == ModelType::SORTFORMER ? ERR_NO_SPEAKERS
                                                   : ERR_NO_SPEECH;
  }

  emitStreamingSegments(drained);
  // Sortformer segments are pre-formatted ("Speaker N: ..."); join with
  // newlines so the JS parser keeps working. ASR joins with spaces.
  const char* separator = isSortformer() ? "\n" : " ";
  std::string joined = joinTranscriptText(drained, separator);

  reopenStreamingSession();
  return joined;
}

void ParakeetModel::process(const Input& input) {
  throwIfCancelled();

  if (input.empty()) {
    QLOG(logger::Priority::WARNING, "Empty audio input received");
    return;
  }

  ++processCalls_;
  totalSamples_ += static_cast<int64_t>(input.size());

  const float startTime = processed_time_;
  const float duration  =
      static_cast<float>(input.size()) / static_cast<float>(SAMPLE_RATE);

  std::string text;
  bool streamed = false;
  const int64_t wall = measureMs([&] {
    if (!is_loaded_) {
      text = ERR_MODEL_NOT_LOADED;
      return;
    }
    try {
      throwIfCancelled();
      const bool hasSession =
          (cfg_.modelType == ModelType::SORTFORMER ? diar_session_ != nullptr
                                                   : asr_session_ != nullptr);
      if (cfg_.streaming && hasSession) {
        // runStreamingProcess already pushes per-segment Transcripts, so
        // skip the single-Transcript push below.
        text = runStreamingProcess(input);
        streamed = true;
      } else if (cfg_.modelType == ModelType::SORTFORMER) {
        text = runSortformerProcess(input);
      } else {
        text = runAsrProcess(input);
      }
      throwIfCancelled();
    } catch (const std::exception& e) {
      if (isCancellationError(e)) throw;
      QLOG(logger::Priority::ERROR,
           std::string("Inference error: ") + e.what());
      text = ERR_INFERENCE;
    }
  });
  totalWallMs_ += wall;
  processed_time_ += duration;

  if (streamed) {
    // On a silence sentinel the streaming drain emitted nothing, so push a
    // single "no speech" placeholder to keep one Output per process().
    if (text.empty() || isSentinel(text)) {
      Transcript transcript;
      transcript.text     = text.empty() ? ERR_NO_SPEECH : text;
      transcript.start    = startTime;
      transcript.end      = startTime + duration;
      transcript.toAppend = true;
      output_.push_back(transcript);
      ++totalTranscriptions_;
      if (on_segment_) on_segment_(transcript);
    }
    return;
  }

  Transcript transcript;
  transcript.text     = text;
  transcript.start    = startTime;
  transcript.end      = startTime + duration;
  transcript.toAppend = true;

  output_.push_back(transcript);
  ++totalTranscriptions_;

  if (on_segment_) on_segment_(transcript);
}

ParakeetModel::Output
ParakeetModel::process(const Input& input,
                       std::function<void(const Output&)> callback) {
  process(input);
  Output result = std::move(output_);
  output_.clear();
  if (callback) callback(result);
  return result;
}

std::any ParakeetModel::process(const std::any& input) {
  AnyInput modelInput;
  if (const auto* anyInput = std::any_cast<AnyInput>(&input)) {
    modelInput = *anyInput;
  } else if (const auto* inputVector = std::any_cast<Input>(&input)) {
    modelInput.input = *inputVector;
  } else {
    throw std::invalid_argument(
        std::string("Invalid input type for ParakeetModel::process: ") +
        input.type().name());
  }

  const auto generation =
      nextGeneration_.fetch_add(1, std::memory_order_relaxed);
  reset();
  activeGeneration_.store(generation, std::memory_order_relaxed);
  try {
    process(modelInput.input);
  } catch (...) {
    activeGeneration_.store(0, std::memory_order_relaxed);
    throw;
  }
  activeGeneration_.store(0, std::memory_order_relaxed);

  Output result = std::move(output_);
  output_.clear();
  return result;
}

std::string ParakeetModel::getName() const {
  return "qvac-parakeet (ggml)";
}

RuntimeStats ParakeetModel::runtimeStats() const {
  RuntimeStats stats;
  stats.emplace_back("processCalls",        static_cast<int64_t>(processCalls_));
  stats.emplace_back("totalSamples",        static_cast<int64_t>(totalSamples_));
  stats.emplace_back("totalTokens",         static_cast<int64_t>(totalTokens_));
  stats.emplace_back("totalTranscriptions", static_cast<int64_t>(totalTranscriptions_));
  stats.emplace_back("totalWallMs",         static_cast<int64_t>(totalWallMs_));
  // Legacy alias of totalWallMs; addon-cpp output handlers expect this key.
  stats.emplace_back("totalTime",           static_cast<int64_t>(totalWallMs_));
  stats.emplace_back("modelLoadMs",         static_cast<int64_t>(modelLoadMs_));
  stats.emplace_back("encoderMs",           static_cast<int64_t>(encoderMs_));
  stats.emplace_back("decoderMs",           static_cast<int64_t>(decoderMs_));
  stats.emplace_back("melSpecMs",           static_cast<int64_t>(melSpecMs_));
  stats.emplace_back("totalEncodedFrames",  static_cast<int64_t>(totalEncodedFrames_));

  // Active backend captured at load(): backendDevice is the device class
  // (0 = CPU, 1 = GPU); backendId identifies the GPU backend family.
  stats.emplace_back("backendDevice",       static_cast<int64_t>(backend_device_));
  stats.emplace_back("backendId",           static_cast<int64_t>(backend_id_));
  stats.emplace_back(
      "gpuUnsupported", static_cast<int64_t>(backend_gpu_unsupported_));

  // audioDurationMs derived from samples / sample_rate
  const double sr = sample_rate_ > 0
                        ? static_cast<double>(sample_rate_)
                        : static_cast<double>(SAMPLE_RATE);
  stats.emplace_back("audioDurationMs",
                     static_cast<int64_t>(static_cast<double>(totalSamples_) /
                                          sr * 1000.0));
  return stats;
}

} // namespace qvac_lib_infer_parakeet
