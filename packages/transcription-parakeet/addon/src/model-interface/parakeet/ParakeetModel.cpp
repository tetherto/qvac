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

// Stable numeric mapping from parakeet::Engine::backend_name()
// to the integer code surfaced on JS as `RuntimeStats.backendId`.
// Match by prefix because ggml_backend_name() returns indexed strings
// like "CUDA0" / "Vulkan0" / "MTL0" when multiple GPUs of the same
// family are present. Keep in sync with index.d.ts BackendId comment.
//
// Metal note: ggml-metal at the qvac-parakeet pin (upstream 58c38058)
// reports the device as `"MTL0"` from `ggml_backend_name()` despite
// parakeet's own header advertising the name as `"Metal"`. Treat both
// forms (and any future indexed `MetalN` variant) as the Metal family.
int backendIdFromName(const std::string& name) {
  if (name == "CPU") return 0;
  if (name.rfind("Metal",  0) == 0 || name.rfind("MTL", 0) == 0) return 1;
  if (name.rfind("CUDA",   0) == 0) return 2;
  if (name.rfind("Vulkan", 0) == 0) return 3;
  if (name.rfind("OpenCL", 0) == 0) return 4;
  return 99;
}

// Maps a ggml backend *registry* name (e.g. "CUDA", "Vulkan", "Metal",
// "OpenCL") to the same numeric family code as backendIdFromName, so the
// device the engine selected can be matched against the ggml device registry
// to recover its human-readable description.
int backendIdFromRegName(std::string regName) {
  std::transform(
      regName.begin(), regName.end(), regName.begin(), [](unsigned char c) {
        return std::tolower(c);
      });
  if (regName.rfind("metal", 0) == 0)
    return 1;
  if (regName.rfind("cuda", 0) == 0)
    return 2;
  if (regName.rfind("vulkan", 0) == 0)
    return 3;
  if (regName.rfind("opencl", 0) == 0)
    return 4;
  return 99;
}

// Human-readable description of the active GPU device (e.g.
// "NVIDIA GeForce RTX 3090", "Apple M2 Pro"), recovered from the ggml device
// registry after the engine has registered its backends. This is the fallback
// the perf reporter uses on CI runners where nvidia-smi / procfs are
// unavailable but the ggml backend (CUDA / Vulkan / Metal) still knows the
// device name via cudaGetDeviceProperties / VkPhysicalDeviceProperties /
// MTLDevice.name. Returns "" when the active backend is CPU or no GPU device
// is registered. Best-effort on a multi-GPU host: prefers the first device
// whose backend family matches what the engine reported, else the first
// GPU/IGPU device.
std::string captureBackendDescription(int backendId, int backendDevice) {
  if (backendDevice != 1) {
    return ""; // CPU backend: no GPU hardware name to report.
  }

  ggml_backend_dev_t firstGpu = nullptr;
  const size_t devCount = ggml_backend_dev_count();
  for (size_t i = 0; i < devCount; ++i) {
    ggml_backend_dev_t dev = ggml_backend_dev_get(i);
    if (dev == nullptr) {
      continue;
    }
    const enum ggml_backend_dev_type type = ggml_backend_dev_type(dev);
    if (type != GGML_BACKEND_DEVICE_TYPE_GPU &&
        type != GGML_BACKEND_DEVICE_TYPE_IGPU) {
      continue;
    }
    if (firstGpu == nullptr) {
      firstGpu = dev;
    }
    ggml_backend_reg_t reg = ggml_backend_dev_backend_reg(dev);
    const char* regName = (reg != nullptr) ? ggml_backend_reg_name(reg) : "";
    if (backendIdFromRegName(regName != nullptr ? regName : "") == backendId) {
      const char* desc = ggml_backend_dev_description(dev);
      if (desc != nullptr && desc[0] != '\0') {
        return desc;
      }
      const char* devName = ggml_backend_dev_name(dev);
      return (devName != nullptr) ? devName : "";
    }
  }

  if (firstGpu != nullptr) {
    const char* desc = ggml_backend_dev_description(firstGpu);
    if (desc != nullptr && desc[0] != '\0') {
      return desc;
    }
    const char* devName = ggml_backend_dev_name(firstGpu);
    return (devName != nullptr) ? devName : "";
  }
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

// ─────────────────────────────────────────────────────────────────────────
//  ggml -> qvac-logging bridge
// ─────────────────────────────────────────────────────────────────────────
// ggml's metal / vulkan / opencl backends log via fprintf-to-stderr by
// default, which bypasses the binding's QLOG() pipe and bleeds into
// example output (`ggml_metal_library_compile_pipeline: ...` lines on
// every kernel JIT). We install a process-wide ggml log callback that
// rewrites each line as a QLOG() call so:
//   - by default (no `setLogger()` from JS), QLOG is a no-op and ggml
//     stays silent;
//   - with `--native-logs` (a.k.a. `binding.setLogger(...)`), ggml info
//     / warning / error lines flow through the same JS logger as the
//     binding's own messages, prefixed by `[C++ INFO]` etc.
//
// Multi-part lines (GGML_LOG_LEVEL_CONT, used e.g. when a metal
// pipeline compile splits into two prints) are buffered and flushed
// together so QLOG sees one logical line per ggml line.

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

void ggmlLogTrampoline(ggml_log_level level, const char * text, void * /*user_data*/) {
  if (!text) return;
  std::lock_guard<std::mutex> lk(ggmlLogBufMutex());
  if (level != GGML_LOG_LEVEL_CONT)
    ggmlLogBufLevel() = level;
  ggmlLogBuf().append(text);
  // Flush whole lines as they arrive; ggml emits both `\n`-terminated
  // strings and bare fragments, so we drain every newline we see.
  for (size_t nl = ggmlLogBuf().find('\n'); nl != std::string::npos;
       nl = ggmlLogBuf().find('\n')) {
    std::string line = ggmlLogBuf().substr(0, nl);
    ggmlLogBuf().erase(0, nl + 1);
    if (line.empty()) continue;
    QLOG(ggmlLevelToPriority(ggmlLogBufLevel()), line);
  }
}

void installGgmlLogTrampolineOnce() {
  static std::once_flag once;
  std::call_once(once, [] {
    ggml_log_set(&ggmlLogTrampoline, nullptr);
  });
}

} // namespace

// ─────────────────────────────────────────────────────────────────────────
//  Constructor / destructor
// ─────────────────────────────────────────────────────────────────────────

ParakeetModel::ParakeetModel(const ParakeetConfig& config) : cfg_(config) {
  if (cfg_.sampleRate != 0) {
    sample_rate_ = cfg_.sampleRate;
  }
}

ParakeetModel::~ParakeetModel() {
  try {
    unload();
  } catch (...) {
    // destructors must not throw
  }
}

// ─────────────────────────────────────────────────────────────────────────
//  Lifecycle
// ─────────────────────────────────────────────────────────────────────────

void ParakeetModel::initializeBackend() {
  // Backend init for ggml is handled inside Engine's constructor (which
  // picks Metal / Vulkan / OpenCL / CPU based on which ggml backends are
  // compiled in). All we need to do here is route ggml's own log lines
  // through the binding's QLOG() pipe so they obey --native-logs (or
  // stay silent by default) instead of bleeding to stderr.
  installGgmlLogTrampolineOnce();
}

std::filesystem::path ParakeetModel::writeBufferToTempFile() {
  if (gguf_buffer_.empty()) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "ParakeetModel::load: no GGUF bytes received before load()");
  }

  // Generate a per-process unique temp filename. We avoid std::tmpnam
  // because it's racy + deprecated, and we want a deterministic-ish
  // suffix so multiple ParakeetModel instances in the same process
  // don't collide.
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

void ParakeetModel::load() {
  if (is_loaded_) return;

  QLOG(logger::Priority::INFO,
       "Loading Parakeet GGUF (modelType hint: " +
           std::to_string(static_cast<int>(cfg_.modelType)) + ")");

  modelLoadMs_ = measureMs([&] {
    fs::path ggufPath;

    // Two ways to source the GGUF:
    //   1. Caller streamed bytes via setWeightsForFile() -- we materialise
    //      them to a temp file. This is the path the addon framework
    //      uses by default.
    //   2. Caller pre-set `cfg_.modelPath` to an existing GGUF on disk.
    //      We skip the temp-file dance and load from the path directly.
    // Prefer cfg_.modelPath when it points at an existing file -- avoids
    // the temp-file copy entirely. setWeightsForFile() bytes are the
    // fallback for callers that don't have direct filesystem access.
    if (!cfg_.modelPath.empty() && fs::exists(cfg_.modelPath)) {
      ggufPath = cfg_.modelPath;
    } else if (gguf_completed_ && !gguf_buffer_.empty()) {
      gguf_temp_path_ = writeBufferToTempFile();
      ggufPath = gguf_temp_path_;
    } else {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          "ParakeetModel::load: no GGUF available "
          "(no setWeightsForFile() bytes and modelPath is missing or empty)");
    }

    installGgmlLogTrampolineOnce();
    parakeet::EngineOptions eopts;
    eopts.model_gguf_path = ggufPath.string();
    // n_threads = 0 lets ggml pick hardware_concurrency, matching the
    // standalone CLI's default. cfg_.maxThreads is honoured only when
    // explicitly set non-zero.
    eopts.n_threads       = cfg_.maxThreads > 0 ? cfg_.maxThreads : 0;
    // Engine picks the GPU backend based on ggml's compile-time backends
    // when n_gpu_layers > 0; we leave it at 0 for back-compat with the
    // legacy CPU-only path and bump only when cfg_.useGPU is true.
    eopts.n_gpu_layers    = cfg_.useGPU ? 999 : 0;
    eopts.verbose         = false;
    // Compose the actual backends-scan directory from the host-
    // provided prebuilds root plus the cmake-bare per-target subdir
    // (BACKENDS_SUBDIR, e.g. `android-arm64/qvac__transcription-parakeet`).
    // Mirrors the exact shape qvac/packages/llm-llamacpp uses in
    // addon/src/model-interface/LlamaLazyInitializeBackend.cpp so a
    // host that already passes `path.join(__dirname, 'prebuilds')`
    // gets the same resolution semantics across both addons. Empty
    // backendsDir -> leave eopts.backends_dir empty so parakeet-cpp
    // falls back to ggml's compile-time default search path
    // (`ggml_backend_load_all()` rather than `..._from_path()`).
    if (!cfg_.backendsDir.empty()) {
      fs::path backendsDirPath(cfg_.backendsDir);
#ifdef BACKENDS_SUBDIR
      backendsDirPath =
          (backendsDirPath / fs::path(BACKENDS_SUBDIR)).lexically_normal();
#endif
      eopts.backends_dir = backendsDirPath.string();
    }
    // Forwarded as-is. Empty string -> leave $GGML_OPENCL_CACHE_DIR
    // alone (the env-set-by-host path still wins). Only consumed on
    // Android by parakeet::set_opencl_cache_dir(); other platforms
    // ignore it. Process-singleton scoped: a second Engine ctor with
    // a different value is silently ignored on the parakeet-cpp side
    // because ggml-opencl only reads the env var once at first init.
    eopts.opencl_cache_dir = cfg_.openclCacheDir;

    {
      std::lock_guard<std::mutex> lk(engine_mutex_);
      engine_ = std::make_unique<parakeet::Engine>(eopts);
    }
  });

  is_loaded_ = true;

  // Auto-detect modelType from the loaded GGUF's metadata. The engine
  // returns "ctc" / "tdt" / "eou" / "sortformer" reflecting the
  // `parakeet.model.type` GGUF metadata field, so JS callers don't
  // need to pass `modelType` themselves -- the binding picks the
  // right dispatch (ASR vs Sortformer) automatically. We only fall
  // back to whatever cfg_.modelType the caller passed if the engine
  // reports something unrecognised.
  if (engine_) {
    const std::string detected = engine_->model_type();
    if (detected == "ctc")        cfg_.modelType = ModelType::CTC;
    else if (detected == "tdt")   cfg_.modelType = ModelType::TDT;
    else if (detected == "eou")   cfg_.modelType = ModelType::EOU;
    else if (detected == "sortformer") cfg_.modelType = ModelType::SORTFORMER;

    backend_device_ =
        engine_->backend_device() == parakeet::BackendDevice::GPU ? 1 : 0;
    backend_name_   = engine_->backend_name();
    backend_id_     = backendIdFromName(backend_name_);
    backend_gpu_unsupported_ = engine_->gpu_unsupported() ? 1 : 0;
    backend_description_ =
        captureBackendDescription(backend_id_, backend_device_);

    QLOG(
        logger::Priority::INFO,
        std::string("Parakeet engine loaded; model_type=") + detected +
            " backend=" + backend_name_ +
            " (device=" + (backend_device_ == 1 ? "GPU" : "CPU") +
            ", id=" + std::to_string(backend_id_) + ", gpu='" +
            backend_description_ + "')");
    if (cfg_.useGPU && backend_device_ != 1 && !backend_gpu_unsupported_) {
      QLOG(logger::Priority::WARNING,
           "Parakeet: useGPU=true was requested but the active backend is CPU. "
           "The platform's GPU backend either isn't compiled in or refused to "
           "initialise (e.g. missing OpenCL ICD, Adreno-tier policy, simulator "
           "without Metal). Falling back to CPU.");
    }
  }

  if (cfg_.streaming) {
    try {
      openStreamingSession();
    } catch (const std::exception& e) {
      QLOG(logger::Priority::ERROR,
           std::string("Failed to open streaming session: ") + e.what());
      throw;
    }
  }

  // Best-effort sample-rate sanity check. The engine itself doesn't expose
  // its mel preprocessor's expected sample rate today (it's hardcoded to
  // 16 kHz inside qvac-parakeet.cpp), so we just warn if the caller asked
  // for something else.
  if (sample_rate_ != static_cast<int>(SAMPLE_RATE)) {
    QLOG(logger::Priority::WARNING,
         "Parakeet engine assumes 16 kHz audio; cfg.sampleRate=" +
             std::to_string(sample_rate_) +
             " will be ignored at the engine boundary");
  }

  // Free the staging buffer; we kept it only to feed the engine.
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
  // reload() requires a persistent cfg_.modelPath. unload() clears
  // gguf_buffer_, so a model originally loaded from a streamed byte
  // buffer (loadWeights()) without a backing file on disk would fail to
  // re-open here. The JS layer always writes the bytes to a temp file
  // before calling load(), so cfg_.modelPath is set in practice; surface
  // a clear error if a future caller skips that step.
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

  // Drain any segments emitted by finalize() into output_ + on_segment_
  // so the trailing partial chunk surfaces in the next runtimeStats()
  // tick / next process() return.
  std::vector<Transcript> drained;
  {
    std::lock_guard<std::mutex> lk(streaming_mutex_);
    drained.swap(pending_streaming_segments_);
  }
  for (auto& seg : drained) {
    output_.push_back(seg);
    if (on_segment_) on_segment_(seg);
    ++totalTranscriptions_;
  }
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
    // warmup failures are non-fatal
  }
  output_.clear();
  is_warmed_up_ = true;
}

// ─────────────────────────────────────────────────────────────────────────
//  Cancellation
// ─────────────────────────────────────────────────────────────────────────

void ParakeetModel::throwIfCancelled() const {
  const auto active = activeGeneration_.load(std::memory_order_relaxed);
  const auto cancel = cancelGeneration_.load(std::memory_order_relaxed);
  if (active != 0 && cancel >= active) {
    // The framework's GeneralErrorCode set doesn't include
    // OperationCanceled; we raise InternalError with the recognised
    // ERR_JOB_CANCELLED text so isCancellationError() can detect it
    // upstream.
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
  // Streaming sessions own their own cancel() that interrupts any
  // in-flight feed_pcm_f32. Best-effort -- the JobRunner's framework
  // also waits for processingSync.
  //
  // cancel() is documented as concurrent with process()/unload()/reload(),
  // and openStreamingSession() / closeStreamingSession() / endOfStream() /
  // ~ParakeetModel all .reset() the unique_ptrs from another thread.
  // Snapshot raw pointers under session_mutex_ so we don't race against a
  // concurrent .reset(); the engine's session-internal cancel() is itself
  // thread-safe with concurrent feed/finalize, so we can release the lock
  // before invoking it.
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

// ─────────────────────────────────────────────────────────────────────────
//  Weight loading
// ─────────────────────────────────────────────────────────────────────────

void ParakeetModel::set_weights_for_file(const std::string& filename,
                                         std::span<const uint8_t> contents,
                                         bool completed) {
  // We expect a single GGUF; any other extension is rejected with the
  // same error code the legacy binding used so JS callers see no shape
  // change.
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
  // Drain the streambuf without relying on seekg/tellg (which not all
  // streambuf implementations support; bare's stream wrappers and
  // simple test fakes both lack seekoff overrides). We read in 64 KiB
  // chunks until sgetn returns less than the requested size, which
  // signals EOF.
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

// ─────────────────────────────────────────────────────────────────────────
//  Static helpers
// ─────────────────────────────────────────────────────────────────────────

std::vector<float>
ParakeetModel::preprocessAudioData(const std::vector<uint8_t>& audioData,
                                   const std::string& audioFormat) {
  if (audioFormat != "s16le") {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "ParakeetModel::preprocessAudioData: only s16le PCM is supported");
  }
  const size_t nSamples = audioData.size() / 2;
  std::vector<float> out(nSamples);
  constexpr float inv = 1.0f / 32768.0f;
  for (size_t i = 0; i < nSamples; ++i) {
    const int16_t s = static_cast<int16_t>(
        audioData[i * 2] | (audioData[i * 2 + 1] << 8));
    out[i] = static_cast<float>(s) * inv;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
//  Engine dispatch
// ─────────────────────────────────────────────────────────────────────────

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
  // Record per-stage timings verbatim from the engine. The earlier
  // fallback (substitute the entire transcribe_samples wall-clock when
  // encoder_ms == 0) silently mis-attributed mel + decoder time as
  // encoder time, inflating the encoder bucket roughly 3-5x on the
  // first call. Engines that don't report encoder_ms record 0; callers
  // that need the full-pipeline wall clock can derive it from
  // melSpecMs_ + encoderMs_ + decoderMs_.
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

  std::ostringstream os;
  for (size_t i = 0; i < diar.segments.size(); ++i) {
    const auto& s = diar.segments[i];
    if (i > 0) os << "\n";
    os << "Speaker " << s.speaker_id << ": "
       << formatSeconds(static_cast<float>(s.start_s)) << " - "
       << formatSeconds(static_cast<float>(s.end_s));
  }
  return os.str();
}

// ─────────────────────────────────────────────────────────────────────────
//  Streaming session lifecycle
// ─────────────────────────────────────────────────────────────────────────

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
    parakeet::SortformerStreamingOptions opts;
    opts.sample_rate    = sample_rate_;
    opts.chunk_ms       = cfg_.streamingChunkMs > 0 ? cfg_.streamingChunkMs : 2000;
    opts.history_ms     = cfg_.streamingHistoryMs > 0 ? cfg_.streamingHistoryMs : 30000;
    opts.threshold      = diarConfig_.onset;
    opts.min_segment_ms = static_cast<int>(diarConfig_.minDurationOn * 1000.0f);
    opts.emit_partials  = cfg_.streamingEmitPartials;
    // AOSC (v2.1+ Sortformer only; ignored for v1/v2 GGUFs). The engine
    // detects v2.1 via the GGUF metadata tag `parakeet.model_variant` and
    // only consults these fields then -- safe to forward unconditionally.
    opts.spkcache_enable = cfg_.streamingSpkCacheEnable;
    opts.spkcache_len = cfg_.streamingSpkCacheLen;
    opts.fifo_len = cfg_.streamingFifoLen;
    opts.chunk_left_context_ms = cfg_.streamingChunkLeftContextMs;
    opts.chunk_right_context_ms = cfg_.streamingChunkRightContextMs;
    opts.spkcache_update_period = cfg_.streamingSpkCacheUpdatePeriod;

    auto session = engine->diarize_start(
        opts, [this](const parakeet::StreamingDiarizationSegment& seg) {
          // Synthetic terminator (fired on finalize when audio ended on a
          // chunk boundary): nothing to emit.
          if (seg.speaker_id < 0)
            return;
          Transcript t;
          std::ostringstream os;
          os << "Speaker " << seg.speaker_id << ": "
             << formatSeconds(static_cast<float>(seg.start_s)) << " - "
             << formatSeconds(static_cast<float>(seg.end_s));
          t.text     = os.str();
          t.start    = static_cast<float>(seg.start_s);
          t.end      = static_cast<float>(seg.end_s);
          t.toAppend = true;
          {
            std::lock_guard<std::mutex> lk(streaming_mutex_);
            pending_streaming_segments_.push_back(std::move(t));
          }
        });
    {
      std::lock_guard<std::mutex> lk(session_mutex_);
      diar_session_ = std::move(session);
    }
  } else {
    if (cfg_.streamingHistoryMs > 0) {
      QLOG(logger::Priority::WARNING,
           "streamingHistoryMs is Sortformer-only and is ignored for ASR streaming sessions");
    }
    parakeet::StreamingOptions opts;
    opts.sample_rate    = sample_rate_;
    // Match the documented default (2000 ms) when the caller leaves
    // streamingChunkMs at its zero sentinel; the previous 1000 ms fallback
    // diverged from README / index.d.ts / ParakeetConfig advertisements.
    opts.chunk_ms       = cfg_.streamingChunkMs > 0 ? cfg_.streamingChunkMs : 2000;
    if (cfg_.streamingLeftContextMs > 0) {
      opts.left_context_ms = cfg_.streamingLeftContextMs;
    }
    if (cfg_.streamingRightLookaheadMs >= 0) {
      opts.right_lookahead_ms = cfg_.streamingRightLookaheadMs;
    }
    opts.emit_partials  = cfg_.streamingEmitPartials;
    opts.enable_energy_vad = cfg_.streamingEnergyVad;

    auto session = engine->stream_start(
        opts, [this](const parakeet::StreamingSegment& seg) {
          if (seg.text.empty() && !seg.is_eou_boundary)
            return;
          Transcript t;
          t.text        = seg.text;
          t.start       = static_cast<float>(seg.start_s);
          t.end         = static_cast<float>(seg.end_s);
          t.toAppend    = true;
          t.isEndOfTurn = seg.is_eou_boundary;
          t.startsWord  = seg.starts_word;
          {
            std::lock_guard<std::mutex> lk(streaming_mutex_);
            pending_streaming_segments_.push_back(std::move(t));
          }
        });
    {
      std::lock_guard<std::mutex> lk(session_mutex_);
      asr_session_ = std::move(session);
    }
  }
}

void ParakeetModel::closeStreamingSession() {
  // Snapshot-and-release pattern: take ownership of the unique_ptrs under
  // session_mutex_ so a concurrent cancel() can't observe a half-destroyed
  // session, then run the (potentially blocking) session->cancel() and
  // ~Session calls outside the lock.
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

std::string ParakeetModel::runStreamingProcess(const Input& input) {
  if (input.empty()) return ERR_AUDIO_SHORT;
  if (streaming_finalized_) {
    QLOG(logger::Priority::WARNING,
         "process() called after streaming session was finalized; ignoring");
    return std::string();
  }

  // The JS append() layer batches every chunk for a job in JS memory and
  // forwards the concatenated buffer in a single 'end of job' runJob call
  // (see parakeet.js); the framework's IModel interface has no separate
  // end-of-stream hook, so process() is invoked exactly once per JS run().
  // Feed the batch, then immediately finalize the session so
  // flush_remainder() processes the trailing right_lookahead window. Without
  // the finalize, ~chunk_ms + right_lookahead_ms of audio (3 s on default
  // settings) sit in StreamSession::pending and the terminal <EOU> never
  // reaches eou_decode_window.
  const int64_t t = measureMs([&] {
    if (cfg_.modelType == ModelType::SORTFORMER) {
      if (diar_session_) {
        diar_session_->feed_pcm_f32(input.data(),
                                    static_cast<int>(input.size()));
        try { diar_session_->finalize(); } catch (...) {}
      }
    } else {
      if (asr_session_) {
        asr_session_->feed_pcm_f32(input.data(),
                                   static_cast<int>(input.size()));
        try { asr_session_->finalize(); } catch (...) {}
      }
    }
  });
  encoderMs_ += t;
  streaming_audio_seconds_ +=
      static_cast<double>(input.size()) / static_cast<double>(sample_rate_);

  // Drain segments collected via the streaming callback during the feed
  // (and during the finalize() flush above).
  std::vector<Transcript> drained;
  {
    std::lock_guard<std::mutex> lk(streaming_mutex_);
    drained.swap(pending_streaming_segments_);
  }

  if (drained.empty()) {
    return cfg_.modelType == ModelType::SORTFORMER ? ERR_NO_SPEAKERS
                                                   : ERR_NO_SPEECH;
  }

  for (auto& seg : drained) {
    output_.push_back(seg);
    if (on_segment_) on_segment_(seg);
    ++totalTranscriptions_;
  }

  // Concatenate text from drained segments for back-compat with callers
  // that read process()'s return string directly. Sortformer segments
  // are already pre-formatted ("Speaker N: ..."); join with newlines so
  // the JS-side parser keeps working unchanged.
  std::ostringstream os;
  const char* sep = (cfg_.modelType == ModelType::SORTFORMER) ? "\n" : " ";
  for (size_t i = 0; i < drained.size(); ++i) {
    if (i > 0) os << sep;
    os << drained[i].text;
  }

  // The session was finalized above, so feed_pcm_f32 would throw on the
  // next process() call. Reopen a fresh session for the next job; each JS
  // run() on this framework path is treated as an independent utterance.
  //
  // IMPORTANT (cross-call streaming state): the close+reopen below WIPES
  // engine-side streaming state that consumers may believe survives across
  // process() calls -- specifically:
  //   * Sortformer cross-chunk speaker history (the engine starts over)
  //   * EOU rolling window / partial decode state for ASR
  //   * the streaming session's internal sample-position clock
  // i.e. README / index.d.ts / ParakeetConfig::streaming language about
  // "preserves speaker IDs across appends" applies to a SINGLE run() call
  // (which the JS append() layer batches into one process() invocation),
  // NOT across multiple run() calls on the same model instance. Use the
  // duplex `runStreaming()` API (ParakeetStreamingProcessor) when you
  // need a single long-lived session that survives across many append()
  // batches without resetting -- the duplex path owns its own
  // parakeet::StreamSession that is never closed mid-flight by the
  // framework.
  closeStreamingSession();
  try {
    openStreamingSession();
  } catch (const std::exception& e) {
    QLOG(logger::Priority::WARNING,
         std::string("Failed to reopen streaming session: ") + e.what());
  }

  return os.str();
}

// ─────────────────────────────────────────────────────────────────────────
//  IModel API
// ─────────────────────────────────────────────────────────────────────────

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
        // runStreamingProcess drains the per-segment callback queue
        // straight into output_ + on_segment_, so we must skip the
        // legacy single-Transcript push below.
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
    // Streaming path already pushed per-segment Transcripts during
    // runStreamingProcess's drain. If the engine emitted nothing at
    // all for this chunk (silence sentinel), emit a single placeholder
    // so the JS side still gets one Output per process() with an
    // unambiguous "no speech" signal -- matches legacy behaviour.
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
  // RuntimeStats is a `vector<pair<string, variant<double, int64_t>>>` --
  // a flat key/value list.
  RuntimeStats stats;
  stats.emplace_back("processCalls",        static_cast<int64_t>(processCalls_));
  stats.emplace_back("totalSamples",        static_cast<int64_t>(totalSamples_));
  stats.emplace_back("totalTokens",         static_cast<int64_t>(totalTokens_));
  stats.emplace_back("totalTranscriptions", static_cast<int64_t>(totalTranscriptions_));
  stats.emplace_back("totalWallMs",         static_cast<int64_t>(totalWallMs_));
  // Legacy alias of totalWallMs; the addon-cpp output handlers and
  // AddonCppTest expect this key by name.
  stats.emplace_back("totalTime",           static_cast<int64_t>(totalWallMs_));
  stats.emplace_back("modelLoadMs",         static_cast<int64_t>(modelLoadMs_));
  stats.emplace_back("encoderMs",           static_cast<int64_t>(encoderMs_));
  stats.emplace_back("decoderMs",           static_cast<int64_t>(decoderMs_));
  stats.emplace_back("melSpecMs",           static_cast<int64_t>(melSpecMs_));
  stats.emplace_back("totalEncodedFrames",  static_cast<int64_t>(totalEncodedFrames_));

  // Active backend, captured once at load() and stable for the
  // lifetime of the model. `backendDevice` is the post-fallback
  // device class (0 = CPU, 1 = GPU); `backendId` identifies which
  // GPU backend is engaged (see backendIdFromName above for the
  // mapping). Both are int64 to fit RuntimeStats's variant; the JS
  // side reads them from runtimeStats() (a.k.a. response.stats).
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
