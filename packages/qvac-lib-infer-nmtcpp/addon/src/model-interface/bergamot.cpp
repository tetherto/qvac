#include "bergamot.hpp"

#include <chrono>
#include <iostream>
#include <stdexcept>
#include <sstream>
#include <filesystem>
#include <fstream>

#include "translator/service.h"
#include "translator/response.h"
#include "translator/response_options.h"
#include "translator/translation_model.h"
#include "translator/parser.h"
#include "common/options.h"
#include "common/logging.h"
#include "qvac-lib-inference-addon-cpp/Logger.hpp"

#ifdef USE_INTGEMM
#include "intgemm/intgemm.h"

// Helper to convert intgemm CPUType to string
static const char* cpuTypeToString(intgemm::CPUType type) {
  switch (type) {
    case intgemm::CPUType::SSE2: return "SSE2";
    case intgemm::CPUType::SSSE3: return "SSSE3";
    case intgemm::CPUType::AVX2: return "AVX2";
    case intgemm::CPUType::AVX512BW: return "AVX512BW";
    case intgemm::CPUType::AVX512VNNI: return "AVX512VNNI";
    default: return "UNSUPPORTED";
  }
}
#endif

// Helper function to validate file paths and extensions
// Returns empty string on success, error message on failure
static std::string validateBergamotFile(
    const std::string& path, const std::string& expectedExt,
    const std::string& fileType) {

  if (path.empty()) {
    return fileType + " path is empty";
  }

  // u8path interprets the string as UTF-8, avoiding ANSI
  // code-page corruption on Windows for non-ASCII paths.
  // NOLINTNEXTLINE(clang-diagnostic-deprecated-declarations)
  auto pathObj = std::filesystem::u8path(path);

  if (!std::filesystem::exists(pathObj)) {
    return fileType + " file not found: " + path;
  }

  if (!std::filesystem::is_regular_file(pathObj)) {
    return fileType + " path is not a regular file: " + path;
  }

  std::string ext = pathObj.extension().string();

  if (ext != expectedExt) {
    return fileType + " file must have " + expectedExt +
           " extension, got: " + ext + " (path: " + path + ")";
  }

  std::ifstream test(pathObj);
  if (!test.good()) {
    return fileType + " file is not readable: " + path;
  }

  return ""; // Success
}

// Initialize bergamot context from model path
bergamot_context*
bergamotInit(const char* modelPath, const bergamot_params& params) {
  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::INFO,
      std::string("[BERGAMOT_INIT] Entry, model_path=") + modelPath);

  // Enable throwing exceptions instead of abort() to get meaningful error messages
  marian::setThrowExceptionOnAbort(true);
  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::INFO,
      "[BERGAMOT_INIT] Enabled throwExceptionOnAbort");

  try {
    // Validate model file (.bin extension)
    std::string error = validateBergamotFile(
        params.model_path, ".bin", "Model");
    if (!error.empty()) {
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
          "[BERGAMOT_INIT] " + error);
      return nullptr;
    }

    // Validate source vocab file (.spm extension)
    error = validateBergamotFile(
        params.src_vocab_path, ".spm", "Source vocabulary");
    if (!error.empty()) {
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
          "[BERGAMOT_INIT] " + error);
      return nullptr;
    }

    // Validate destination vocab file (.spm extension)
    error = validateBergamotFile(
        params.dst_vocab_path, ".spm", "Destination vocabulary");
    if (!error.empty()) {
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
          "[BERGAMOT_INIT] " + error);
      return nullptr;
    }

    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::INFO,
        "[BERGAMOT_INIT] All file validations passed");

#ifdef USE_INTGEMM
    // Log detected CPU type for debugging SIMD issues
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::INFO,
        std::string("[BERGAMOT_INIT] Detected CPU type: ") + cpuTypeToString(intgemm::kCPU));
#else
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::INFO,
        "[BERGAMOT_INIT] intgemm not enabled, using RUY for matrix operations");
#endif

    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::INFO,
        "[BERGAMOT_INIT] Creating context");

    // NOLINTNEXTLINE(cppcoreguidelines-owning-memory)
    auto* ctx = new bergamot_context();

    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::INFO,
        "[BERGAMOT_INIT] Creating service configuration");

    // Create service configuration
    marian::bergamot::BlockingService::Config serviceConfig;
    serviceConfig.cacheSize = params.cache_size;

    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::INFO,
        "[BERGAMOT_INIT] Creating blocking service");

    // Create the blocking service
    ctx->service =
        std::make_shared<marian::bergamot::BlockingService>(serviceConfig);

    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::INFO,
        "[BERGAMOT_INIT] Blocking service created");

    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::INFO,
        "[BERGAMOT_INIT] Using explicit model and vocab paths");

    // Use explicit paths from params
    std::string modelPathFull = params.model_path;
    std::string srcvocabPathFull = params.src_vocab_path;
    std::string dstvocabPathFull = params.dst_vocab_path;

    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::INFO,
        "[BERGAMOT_INIT] Model path: " + modelPathFull);
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::INFO,
        "[BERGAMOT_INIT] Source vocab: " + srcvocabPathFull);
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::INFO,
        "[BERGAMOT_INIT] Dest vocab: " + dstvocabPathFull);

    // Build a YAML/JSON config string matching Firefox translations config
    std::ostringstream configStr;
    configStr << "models:\n"
              << "  - " << modelPathFull << "\n"
              << "vocabs:\n"
              << "  - " << srcvocabPathFull << "\n"
              << "  - " << dstvocabPathFull << "\n";

    configStr << "beam-size: " << params.beam_size << "\n"
              << "normalize: " << params.normalize << "\n"
              << "word-penalty: 0\n"
              << "max-length-break: 128\n"
              << "mini-batch-words: 1024\n"
              << "mini-batch: 64\n"
              << "workspace: 128\n"
              << "alignment: soft\n"
              << "max-length-factor: " << params.max_length_factor << "\n"
              << "gemm-precision: int8shiftAlphaAll\n"
              << "skip-cost: true\n"
              << "cpu-threads: " << params.num_workers << "\n"
              << "quiet: true\n"
              << "quiet-translation: true\n";

    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::INFO,
        "[BERGAMOT_INIT] Parsing options from config string");

    // Parse configuration from string
    auto options = marian::bergamot::parseOptionsFromString(
        configStr.str(), /*validate=*/false);

    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::INFO,
        "[BERGAMOT_INIT] Options parsed, creating translation model");

    // Create the translation model
    ctx->model = std::make_shared<marian::bergamot::TranslationModel>(options, /*replicas=*/1);

    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::INFO,
        "[BERGAMOT_INIT] Translation model created successfully");

    return ctx;
  } catch (const std::exception& e) {
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
        std::string("[BERGAMOT_INIT] Failed to initialize bergamot: ") + e.what());
    return nullptr;
  }
}

// Translate text
std::string bergamotTranslate(bergamot_context* ctx, const char* input) {
  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::INFO,
      "[BERGAMOT_TRANSLATE] Starting translation");

  if (ctx == nullptr || !ctx->service || !ctx->model) {
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
        "[BERGAMOT_TRANSLATE] Invalid context");
    return "";
  }

  try {
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::INFO,
        "[BERGAMOT_TRANSLATE] Preparing input");

    auto start = std::chrono::high_resolution_clock::now();

    // Prepare input
    std::vector<std::string> inputs = {std::string(input)};

    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::INFO,
        "[BERGAMOT_TRANSLATE] Preparing response options");

    // Prepare response options
    std::vector<marian::bergamot::ResponseOptions> options(1);
    options[0].qualityScores = false;
    options[0].alignment = false;
    options[0].HTML = false;

    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::INFO,
        "[BERGAMOT_TRANSLATE] Calling translateMultiple");

    // Translate
    std::vector<marian::bergamot::Response> responses;
    try {
      responses = ctx->service->translateMultiple(ctx->model, std::move(inputs), options);
    } catch (const std::exception& e) {
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
          std::string("[BERGAMOT_TRANSLATE] Exception in translateMultiple: ") + e.what());
      throw;
    }

    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::INFO,
        "[BERGAMOT_TRANSLATE] translateMultiple completed");

    auto end = std::chrono::high_resolution_clock::now();
    auto duration = std::chrono::duration_cast<std::chrono::microseconds>(end - start);

    // Update statistics (approximate - bergamot doesn't separate encode/decode)
    // NOLINTNEXTLINE(bugprone-narrowing-conversions,cppcoreguidelines-narrowing-conversions,cppcoreguidelines-avoid-magic-numbers,readability-magic-numbers)
    ctx->total_decode_time += duration.count() / 1000000.0;

    if (!responses.empty()) {
      // Count total tokens across all sentences in the response
      size_t numSentences = responses[0].target.numSentences();
      for (size_t i = 0; i < numSentences; ++i) {
        ctx->total_tokens += static_cast<int>(responses[0].target.numWords(i));
      }
      return responses[0].target.text;
    }

    return "";
  } catch (const std::exception& e) {
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
        std::string("[BERGAMOT_TRANSLATE] Translation failed: ") + e.what());
    return "";
  }
}

bergamot_batch_result bergamotTranslateBatch(
    bergamot_context* ctx, const std::vector<std::string>& texts) {
  bergamot_batch_result result;
  result.translations.resize(texts.size());
  result.success.resize(texts.size());

  if (ctx == nullptr || !ctx->service || !ctx->model) {
    result.error = "invalid context";
    return result;
  }

  if (texts.empty()) {
    return result;
  }

  auto start = std::chrono::high_resolution_clock::now();

  try {
    std::vector<std::string> inputs{texts};
    // response options for each text
    std::vector<marian::bergamot::ResponseOptions> options(texts.size());
    for (auto& opt : options) {
      opt.qualityScores = false;
      opt.alignment = false;
      opt.HTML = false;
    }

    // Translate all at once
    auto responses =
        ctx->service->translateMultiple(ctx->model, std::move(inputs), options);

    auto end = std::chrono::high_resolution_clock::now();
    auto duration =
        std::chrono::duration_cast<std::chrono::microseconds>(end - start);

    // Update timing statistics (total time = decode time for Bergamot, no
    // separate encode)
    // NOLINTNEXTLINE(bugprone-narrowing-conversions,cppcoreguidelines-narrowing-conversions,cppcoreguidelines-avoid-magic-numbers,readability-magic-numbers)
    ctx->total_decode_time += duration.count() / 1000000.0;

    // Extract Results and count tokens
    for (size_t i = 0; i < responses.size(); ++i) {
      result.translations[i] = responses[i].target.text;
      result.success[i] = true;

      // Count tokens for this response (all sentences in the target)
      size_t numSentences = responses[i].target.numSentences();
      for (size_t si = 0; si < numSentences; ++si) {
        ctx->total_tokens += static_cast<int>(responses[i].target.numWords(si));
      }
    }
  } catch (const std::exception& e) {
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
        std::string("[BERGAMOT_TRANSLATE] Translation failed: ") + e.what());
    result.error = e.what();
  }
  return result;
}

// Get runtime statistics
int bergamotGetRuntimeStats(
    bergamot_context* ctx,
    double* encodeTime, // NOLINT(bugprone-easily-swappable-parameters)
    double* decodeTime, int* totalTokens) {
  if (ctx == nullptr) {
    return -1;
  }

  if (encodeTime != nullptr) {
    *encodeTime = ctx->total_encode_time;
  }
  if (decodeTime != nullptr) {
    *decodeTime = ctx->total_decode_time;
  }
  if (totalTokens != nullptr) {
    *totalTokens = ctx->total_tokens;
  }

  return 0;
}

// Reset runtime statistics
void bergamotResetRuntimeStats(bergamot_context* ctx) {
  if (ctx != nullptr) {
    ctx->total_encode_time = 0.0;
    ctx->total_decode_time = 0.0;
    ctx->total_tokens = 0;
  }
}

// Free bergamot context
void bergamotFree(bergamot_context* ctx) {
  delete ctx; // NOLINT(cppcoreguidelines-owning-memory)
}
