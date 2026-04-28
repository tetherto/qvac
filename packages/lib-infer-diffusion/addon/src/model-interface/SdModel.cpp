#include "SdModel.hpp"

#include <chrono>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <sstream>
#include <system_error>
#include <vector>

#define STB_IMAGE_IMPLEMENTATION
#include <stb_image.h>
#define STB_IMAGE_WRITE_IMPLEMENTATION
#include <ggml-backend.h>
#include <picojson/picojson.h>
#include <qvac-lib-inference-addon-cpp/Errors.hpp>
#include <qvac-lib-inference-addon-cpp/Logger.hpp>
#include <stb_image_write.h>

#include "utils/BackendSelection.hpp"
#include "utils/ImageUtils.hpp"
#include "utils/LoggingMacros.hpp"

using namespace qvac_lib_inference_addon_cpp;
using namespace qvac_errors;

// ---------------------------------------------------------------------------
// Thread-local progress context -- sd progress callbacks are process-global,
// so we park the current job pointer in TLS to route progress back.
// ---------------------------------------------------------------------------
namespace {

struct ProgressCtx {
  const SdModel::GenerationJob* job = nullptr;
  std::chrono::steady_clock::time_point startTime;
};

thread_local ProgressCtx tl_progressCtx;
// Thread-local model pointer for abort callback routing -- same pattern as
// tl_progressCtx for progress.  Avoids relying on the process-global
// sd_abort_cb_data when multiple SdModel instances could coexist.
thread_local const SdModel* tl_abortModel = nullptr;

std::string backendDeviceTypeToString(enum ggml_backend_dev_type type) {
  switch (type) {
  case GGML_BACKEND_DEVICE_TYPE_CPU:
    return "CPU";
  case GGML_BACKEND_DEVICE_TYPE_GPU:
    return "GPU";
  case GGML_BACKEND_DEVICE_TYPE_IGPU:
    return "IGPU";
  case GGML_BACKEND_DEVICE_TYPE_ACCEL:
    return "ACCEL";
  default:
    return "UNKNOWN";
  }
}

std::string preferredBackendToString(enum sd_backend_preference_t pref) {
  switch (pref) {
  case SD_BACKEND_PREF_AUTO:
    return "auto";
  case SD_BACKEND_PREF_CPU:
    return "cpu";
  case SD_BACKEND_PREF_GPU:
    return "gpu";
  case SD_BACKEND_PREF_OPENCL:
    return "opencl";
  default:
    return "unknown";
  }
}

void logBackendRegistrySnapshot() {
  using Priority = qvac_lib_inference_addon_cpp::logger::Priority;

  const size_t regCount = ggml_backend_reg_count();
  const size_t devCount = ggml_backend_dev_count();
  QLOG_IF(
      Priority::INFO,
      "GGML backend registry snapshot: " + std::to_string(regCount) +
          " registry entries, " + std::to_string(devCount) + " devices");

  for (size_t i = 0; i < regCount; ++i) {
    ggml_backend_reg_t reg = ggml_backend_reg_get(i);
    const char* regName = reg ? ggml_backend_reg_name(reg) : nullptr;
    const size_t regDevCount = reg ? ggml_backend_reg_dev_count(reg) : 0;
    QLOG_IF(
        Priority::INFO,
        "GGML backend registry[" + std::to_string(i) + "]: name='" +
            std::string(regName ? regName : "<null>") +
            "', devices=" + std::to_string(regDevCount));
  }

  for (size_t i = 0; i < devCount; ++i) {
    ggml_backend_dev_t dev = ggml_backend_dev_get(i);
    if (!dev) {
      QLOG_IF(
          Priority::WARNING,
          "GGML backend device[" + std::to_string(i) + "]: null device handle");
      continue;
    }

    const char* name = ggml_backend_dev_name(dev);
    const char* desc = ggml_backend_dev_description(dev);
    const auto type = ggml_backend_dev_type(dev);
    size_t memFree = 0;
    size_t memTotal = 0;
    ggml_backend_dev_memory(dev, &memFree, &memTotal);

    ggml_backend_reg_t reg = ggml_backend_dev_backend_reg(dev);
    const char* regName = reg ? ggml_backend_reg_name(reg) : nullptr;

    QLOG_IF(
        Priority::INFO,
        "GGML backend device[" + std::to_string(i) + "]: name='" +
            std::string(name ? name : "<null>") + "', desc='" +
            std::string(desc ? desc : "<null>") +
            "', type=" + backendDeviceTypeToString(type) + ", reg='" +
            std::string(regName ? regName : "<null>") +
            "', mem_free=" + std::to_string(memFree) +
            ", mem_total=" + std::to_string(memTotal));
  }
}

void logBackendModulePathSnapshot(
    const std::filesystem::path& backendsDirPath) {
  using Priority = qvac_lib_inference_addon_cpp::logger::Priority;

  std::error_code ec;
  const bool exists = std::filesystem::exists(backendsDirPath, ec);
  QLOG_IF(
      Priority::INFO,
      "Backend module path exists=" + std::string(exists ? "true" : "false") +
          " path='" + backendsDirPath.string() + "'");
  if (ec) {
    QLOG_IF(
        Priority::WARNING,
        "Backend module path existence check error: " + ec.message());
    return;
  }
  if (!exists) {
    return;
  }

  const bool isDir = std::filesystem::is_directory(backendsDirPath, ec);
  QLOG_IF(
      Priority::INFO,
      "Backend module path is_directory=" +
          std::string(isDir ? "true" : "false"));
  if (ec || !isDir) {
    if (ec) {
      QLOG_IF(
          Priority::WARNING,
          "Backend module path type check error: " + ec.message());
    }
    return;
  }

  std::vector<std::string> entries;
  for (const auto& dirEntry :
       std::filesystem::directory_iterator(backendsDirPath, ec)) {
    if (ec) {
      QLOG_IF(
          Priority::WARNING,
          "Backend module path iteration error: " + ec.message());
      break;
    }
    const auto filename = dirEntry.path().filename().string();
    if (filename.rfind("libqvac-diffusion-ggml-", 0) == 0 &&
        dirEntry.path().extension() == ".so") {
      entries.push_back(filename);
    }
  }

  if (entries.empty()) {
    QLOG_IF(
        Priority::WARNING,
        "No qvac diffusion GGML backend modules found under: " +
            backendsDirPath.string());
    return;
  }

  std::ostringstream oss;
  for (size_t i = 0; i < entries.size(); ++i) {
    if (i > 0) {
      oss << ", ";
    }
    oss << entries[i];
  }
  QLOG_IF(
      Priority::INFO,
      "Detected qvac diffusion GGML backend modules: " + oss.str());
}

void sdProgressCallback(int step, int steps, float /*time*/, void* /*data*/) {
  if (!tl_progressCtx.job || !tl_progressCtx.job->progressCallback)
    return;

  const auto elapsed =
      std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::steady_clock::now() - tl_progressCtx.startTime)
          .count();

  std::ostringstream oss;
  oss << R"({"step":)" << step << R"(,"total":)" << steps << R"(,"elapsed_ms":)"
      << elapsed << "}";

  tl_progressCtx.job->progressCallback(oss.str());
}

// Abort callback -- wired into sd_set_abort_callback() so that
// generate_image() can be interrupted mid-denoising.
// Reads from thread-local tl_abortModel (not the global sd_abort_cb_data)
// to avoid concurrency issues when multiple SdModel instances coexist.
bool sdAbortCallback(void* /*data*/) {
  return tl_abortModel && tl_abortModel->isCancelRequested();
}

// RAII wrapper for the sd_image_t* array returned by generate_image().
// Frees each image's pixel buffer and the array itself on destruction,
// even if an exception is thrown mid-iteration (e.g. in encodeToPng or
// outputCallback).  Call release(i) after processing image i to free
// its pixel buffer immediately rather than waiting until destruction.
class SdImageBatch {
public:
  SdImageBatch(sd_image_t* data, int count) : data_(data), count_(count) {}
  ~SdImageBatch() {
    if (!data_)
      return;
    for (int i = 0; i < count_; ++i) {
      free(data_[i].data);
    }
    free(data_);
  }

  SdImageBatch(const SdImageBatch&) = delete;
  SdImageBatch& operator=(const SdImageBatch&) = delete;
  SdImageBatch(SdImageBatch&&) = delete;
  SdImageBatch& operator=(SdImageBatch&&) = delete;

  [[nodiscard]] int count() const { return count_; }
  [[nodiscard]] const sd_image_t& operator[](int i) const {
    if (!data_)
      throw std::runtime_error("SdImageBatch: null data");
    return data_[i];
  }

  // Release pixel buffer for image i immediately after it has been consumed.
  void release(int i) {
    if (!data_)
      return;
    free(data_[i].data);
    data_[i].data = nullptr;
  }

private:
  sd_image_t* const data_;
  const int count_;
};

struct PreparedLoras {
  std::vector<std::string> paths;
  std::vector<sd_lora_t> items;
};

// Mirrors the pinned fork's CLI flow in examples/common/common.hpp:
// build owned path storage first, then build sd_lora_t entries that point
// at that stable storage for the lifetime of generate_image().
PreparedLoras prepareLoras(const std::string& loraPath) {
  PreparedLoras prepared;
  if (loraPath.empty()) {
    return prepared;
  }

  prepared.paths.push_back(loraPath);

  sd_lora_t item{};
  item.is_high_noise = false;
  item.multiplier = 1.0f;
  item.path = prepared.paths.back().c_str();
  prepared.items.push_back(item);

  return prepared;
}

} // namespace

// ---------------------------------------------------------------------------
// Constructor -- stores config, allocates nothing
// ---------------------------------------------------------------------------

SdModel::SdModel(qvac_lib_inference_addon_sd::SdCtxConfig config)
    : config_(std::move(config)), sdCtx_(nullptr, &free_sd_ctx) {

  sd_set_log_callback(SdModel::sdLogCallback, nullptr);
}

// ---------------------------------------------------------------------------
// Destructor -- releases the sd_ctx and all associated GPU/CPU memory
// ---------------------------------------------------------------------------

SdModel::~SdModel() = default;

// ---------------------------------------------------------------------------
// load() -- maps SdCtxConfig -> sd_ctx_params_t, then calls new_sd_ctx()
// ---------------------------------------------------------------------------

void SdModel::load() {
  if (isLoaded())
    return;

  const auto tLoadStart = std::chrono::steady_clock::now();

  sd_ctx_params_t params{};
  sd_ctx_params_init(&params);

  // Load the VAE encoder as well as the decoder so img2img (encode -> denoise
  // -> decode) works.  sd_ctx_params_init() sets vae_decode_only = true by
  // default which skips building the encoder graph and causes:
  //   GGML_ASSERT(!decode_only || decode_graph) in vae_encode()
  params.vae_decode_only = false;

  // -- Model paths ------------------------------------------------------------
  // For FLUX.2 [klein] the GGUF contains only diffusion weights with no SD
  // version metadata KV pairs, so we must use diffusion_model_path.
  // Classic all-in-one SD1.x / SDXL checkpoints use model_path.
  auto optPath = [](const std::string& s) -> const char* {
    return s.empty() ? nullptr : s.c_str();
  };
  params.model_path = optPath(config_.modelPath);
  params.diffusion_model_path = optPath(config_.diffusionModelPath);
  params.clip_l_path = optPath(config_.clipLPath);
  params.clip_g_path = optPath(config_.clipGPath);
  params.t5xxl_path = optPath(config_.t5XxlPath);
  params.llm_path = optPath(config_.llmPath);
  params.vae_path = optPath(config_.vaePath);
  params.taesd_path = optPath(config_.taesdPath);

  // -- Compute ----------------------------------------------------------------
  params.n_threads = config_.nThreads;
  params.flash_attn = config_.flashAttn;
  params.diffusion_flash_attn = config_.diffusionFlashAttn;

  // Load DL GPU backend modules before probing devices / creating the SD
  // context. In GGML_BACKEND_DL mode, device enumeration is empty until these
  // backend modules are loaded.
#ifdef GGML_BACKEND_DL
  {
    static bool backendsLoaded = false;
    if (!backendsLoaded) {
      using Priority = qvac_lib_inference_addon_cpp::logger::Priority;
      if (!config_.backendsDir.empty()) {
        std::filesystem::path backendsDirPath(config_.backendsDir);
#ifdef BACKENDS_SUBDIR
        backendsDirPath = backendsDirPath / BACKENDS_SUBDIR;
        backendsDirPath = backendsDirPath.lexically_normal();
#endif
        QLOG_IF(
            Priority::INFO,
            "Loading GPU backends from: " + backendsDirPath.string());
        logBackendModulePathSnapshot(backendsDirPath);
        ggml_backend_load_all_from_path(backendsDirPath.string().c_str());
      } else {
        QLOG_IF(Priority::INFO, "Loading GPU backends from default path");
        ggml_backend_load_all();
      }
      backendsLoaded = true;
      logBackendRegistrySnapshot();
    }
  }
#endif

  // -- Memory management -----------------------------------------------------
  params.enable_mmap = config_.mmap;
  params.offload_params_to_cpu = config_.offloadToCpu;

  // Resolve the effective backend based on GPU capabilities.
  // Adreno 800+ uses GPU (OpenCL), Adreno 600/700 is forced to CPU,
  // everything else uses GPU (Vulkan).
  auto preferredDevice = config_.device == "cpu"
                             ? sd_backend_selection::BackendDevice::CPU
                             : sd_backend_selection::BackendDevice::GPU;
  auto effectiveDevice =
      sd_backend_selection::resolveBackendForDevice(preferredDevice);
  const bool preferOpenClForAdreno =
      sd_backend_selection::shouldPreferOpenClForAdreno(preferredDevice);

  if (effectiveDevice == sd_backend_selection::BackendDevice::CPU) {
    params.preferred_gpu_backend = SD_BACKEND_PREF_CPU;
  } else if (preferOpenClForAdreno) {
    params.preferred_gpu_backend = SD_BACKEND_PREF_OPENCL;
  } else {
    params.preferred_gpu_backend = SD_BACKEND_PREF_GPU;
  }

  QLOG_IF(
      qvac_lib_inference_addon_cpp::logger::Priority::INFO,
      "Preferred backend passed to stable-diffusion: " +
          preferredBackendToString(params.preferred_gpu_backend) + " (" +
          std::to_string(static_cast<int>(params.preferred_gpu_backend)) + ")");

#if defined(__APPLE__)
  // The ggml Metal backend does not fully support GGML_OP_NORM for
  // non-contiguous tensors (the CLIP text encoder hits this path).
  // Force CLIP to CPU on Apple to avoid a Metal encoder abort.
  params.keep_clip_on_cpu = true;
#else
  params.keep_clip_on_cpu = config_.keepClipOnCpu;
#endif
  params.keep_vae_on_cpu = config_.keepVaeOnCpu;

  // -- Precision -------------------------------------------------------------
  params.wtype = config_.wtype;
  params.tensor_type_rules = config_.tensorTypeRules.empty()
                                 ? nullptr
                                 : config_.tensorTypeRules.c_str();

  // -- Sampling RNG ----------------------------------------------------------
  params.rng_type = config_.rngType;
  params.sampler_rng_type = config_.samplerRngType;

  // -- Prediction type / LoRA ------------------------------------------------
  params.prediction = config_.prediction;
  params.lora_apply_mode = config_.loraApplyMode;

  // -- Convolution options ---------------------------------------------------
  params.diffusion_conv_direct = config_.diffusionConvDirect;
  params.vae_conv_direct = config_.vaeConvDirect;
  params.force_sdxl_vae_conv_scale = config_.forceSDXLVaeConvScale;

  // -- Internal --------------------------------------------------------------
  params.free_params_immediately = config_.freeParamsImmediately;

  sd_ctx_t* raw = new_sd_ctx(&params);
  if (!raw) {
    const std::string path = config_.diffusionModelPath.empty()
                                 ? config_.modelPath
                                 : config_.diffusionModelPath;
    throw StatusError(
        general_error::InternalError,
        "SdModel::load() failed -- could not create stable-diffusion context. "
        "Check model path and format: " +
            path);
  }

  sdCtx_.reset(raw);

  stats_.modelLoadMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                           std::chrono::steady_clock::now() - tLoadStart)
                           .count();
}

// ---------------------------------------------------------------------------
// process() -- applies SdGenHandlers to JSON params, then calls generate_image
// ---------------------------------------------------------------------------

std::any SdModel::process(const std::any& input) {
  if (!isLoaded()) {
    throw StatusError(
        general_error::InternalError,
        "SdModel::process() called before load()");
  }

  const auto& job = std::any_cast<const GenerationJob&>(input);

  cancelRequested_.store(false);
  tl_progressCtx.job = &job;
  tl_progressCtx.startTime = std::chrono::steady_clock::now();
  sd_set_progress_callback(sdProgressCallback, nullptr);
  tl_abortModel = this;
  sd_set_abort_callback(sdAbortCallback, nullptr);

  // Scope guard: clear process-global callbacks on any exit path (including
  // early exceptions from parsing/validation before generate_image runs).
  auto clearCallbacks = [&]() {
    tl_progressCtx.job = nullptr;
    tl_abortModel = nullptr;
    sd_set_progress_callback(nullptr, nullptr);
    sd_set_abort_callback(nullptr, nullptr);
  };
  struct CallbackGuard {
    std::function<void()> fn;
    ~CallbackGuard() { fn(); }
  } guard{clearCallbacks};

  // -- Parse JSON params -----------------------------------------------------
  picojson::value v;
  const std::string parseErr = picojson::parse(v, job.paramsJson);
  if (!parseErr.empty())
    throw StatusError(
        general_error::InvalidArgument,
        "Failed to parse generation params JSON: " + parseErr);
  if (!v.is<picojson::object>())
    throw StatusError(
        general_error::InvalidArgument, "Params must be a JSON object");

  // -- Build SdGenConfig from handlers ---------------------------------------
  qvac_lib_inference_addon_sd::SdGenConfig gen{};
  qvac_lib_inference_addon_sd::applySdGenHandlers(
      gen, v.get<picojson::object>());

  if (gen.mode != "txt2img" && gen.mode != "img2img")
    throw StatusError(
        general_error::InvalidArgument,
        "Unsupported mode: '" + gen.mode + "'. Supported: txt2img, img2img.");

  // -- Build sd_img_gen_params_t ---------------------------------------------
  sd_img_gen_params_t genParams{};
  sd_img_gen_params_init(&genParams);

  PreparedLoras loras = prepareLoras(gen.loraPath);

  genParams.loras = loras.items.empty() ? nullptr : loras.items.data();
  genParams.lora_count = static_cast<uint32_t>(loras.items.size());
  genParams.prompt = gen.prompt.c_str();
  genParams.negative_prompt = gen.negativePrompt.c_str();
  genParams.width = gen.width;
  genParams.height = gen.height;
  genParams.seed = gen.seed;
  genParams.batch_count = gen.batchCount;
  genParams.strength = gen.strength;
  genParams.clip_skip = gen.clipSkip;

  genParams.sample_params.sample_method = gen.sampleMethod;
  genParams.sample_params.scheduler = gen.scheduler;
  genParams.sample_params.sample_steps = gen.steps;
  genParams.sample_params.guidance.txt_cfg = gen.cfgScale;
  genParams.sample_params.guidance.distilled_guidance = gen.guidance;
  genParams.sample_params.guidance.img_cfg =
      gen.imgCfgScale < 0.0f ? gen.cfgScale : gen.imgCfgScale;
  genParams.sample_params.eta = gen.eta;
  genParams.sample_params.flow_shift = config_.flowShift;

  // -- VAE tiling ------------------------------------------------------------
  genParams.vae_tiling_params.enabled = gen.vaeTiling;
  genParams.vae_tiling_params.tile_size_x = gen.vaeTileSizeX;
  genParams.vae_tiling_params.tile_size_y = gen.vaeTileSizeY;
  genParams.vae_tiling_params.target_overlap = gen.vaeTileOverlap;

  // -- Step-caching ----------------------------------------------------------
  sd_cache_params_init(&genParams.cache);
  genParams.cache.mode = gen.cacheMode;
  if (gen.cacheThreshold > 0.0f)
    genParams.cache.reuse_threshold = gen.cacheThreshold;
  if (gen.cacheStart > 0.0f)
    genParams.cache.start_percent = gen.cacheStart;
  if (gen.cacheEnd > 0.0f)
    genParams.cache.end_percent = gen.cacheEnd;

  // -- img2img --------------------------------------------------------------
  //
  // Three code paths depending on model architecture and input shape:
  //
  //   FLUX2 (FLUX2_FLOW_PRED) with N reference images (N>=1):
  //     Uses ref_images -- in-context conditioning. Each reference image is
  //     VAE-encoded into separate latent tokens that the FLUX transformer
  //     attends to via joint attention with distinct RoPE positions. The
  //     target starts from pure noise, so the model preserves features
  //     (skin tone, structure, etc.) from every reference while generating
  //     a fully new image. N>=2 is "fusion" mode -- addressable in the prompt
  //     as @image1, @image2, ...
  //
  //   FLUX (FLUX_FLOW_PRED) with a single reference image:
  //     Same ref_images path as FLUX2, just a single ref. Multi-image is
  //     rejected here because only FLUX2 defines the @imageN placeholders.
  //
  //   All other models (SD1.x, SD2.x, SDXL, SD3):
  //     Uses init_image -- traditional SDEdit. The input image is noised to
  //     the level specified by `strength`, then denoised for the remaining
  //     steps. Lower strength = closer to the original image. Multi-image
  //     is rejected outright for these architectures.
  //
  sd_image_t initImg{}; // single-image (SDEdit or 1x FLUX)
  std::vector<uint8_t> initPng;

  // RAII wrapper for multi-image FLUX fusion reference images. Automatically
  // frees pixel buffers on scope exit (normal or exceptional) using a custom
  // deleter that iterates the vector and frees each sd_image_t.data pointer.
  auto refImgsDeleter = [](std::vector<sd_image_t>* v) {
    if (!v)
      return;
    for (auto& img : *v) {
      if (img.data) {
        free(img.data);
        img.data = nullptr;
      }
    }
    delete v;
  };
  std::unique_ptr<std::vector<sd_image_t>, decltype(refImgsDeleter)> refImgs(
      new std::vector<sd_image_t>(), refImgsDeleter);

  if (gen.mode == "img2img") {
    const bool isFluxFamily = config_.prediction == FLUX2_FLOW_PRED ||
                              config_.prediction == FLUX_FLOW_PRED;
    const bool isFlux2 = config_.prediction == FLUX2_FLOW_PRED;
    const size_t nMulti = job.initImagesBytes.size();

    // -- Input validation: mutual exclusion + FLUX-only for multi -----------
    //
    // These checks mirror the JS-layer validation in index.js but are
    // duplicated here so the C++ API stays safe when called directly from
    // unit tests or bindings that bypass index.js.
    if (!job.initImageBytes.empty() && nMulti > 0)
      throw StatusError(
          general_error::InvalidArgument,
          "img2img: init_image and init_images are mutually exclusive -- "
          "pick one. Use init_images (with FLUX2) for multi-reference "
          "fusion, or init_image for single-image conditioning.");

    if (nMulti > 0 && !isFlux2)
      throw StatusError(
          general_error::InvalidArgument,
          "img2img: init_images (multi-reference fusion) requires a FLUX2 "
          "model with prediction='flux2_flow'. The current model does not "
          "support @image1/@imageN in-context references.");

    // -- Multi-image (FLUX2 "fusion" mode) ---------------------------------
    if (nMulti > 0) {
      refImgs->reserve(nMulti);
      for (size_t i = 0; i < nMulti; ++i) {
        if (job.initImagesBytes[i].empty())
          throw StatusError(
              general_error::InvalidArgument,
              "img2img: init_images[" + std::to_string(i) +
                  "] is empty -- every reference must be a non-empty "
                  "PNG/JPEG buffer.");

        sd_image_t decoded = decodePng(job.initImagesBytes[i]);
        if (!decoded.data)
          throw StatusError(
              general_error::InvalidArgument,
              "img2img: failed to decode init_images[" + std::to_string(i) +
                  "] (corrupt or unsupported format; supported: PNG, JPEG)");
        refImgs->push_back(decoded);
      }

      // Output dimensions come from the JS shim (addon.js::_fillDimsFromImage,
      // which falls back to the first reference's size when the caller omits
      // width/height). C++ callers using the binding directly must supply
      // both dimensions explicitly. auto_resize_ref_image handles the
      // remaining refs.

      // clang-format off
      // NOTE: Homebrew and apt.llvm.org builds of clang-format-19 disagree on
      // whether the std::string(...) branches of this ternary should hang the
      // call open-paren on its own line. Pinning the layout here keeps local
      // and CI bit-for-bit.
      QLOG_IF(
          qvac_lib_inference_addon_cpp::logger::Priority::INFO,
          "img2img: entering FLUX2 *fusion* mode -- " + std::to_string(nMulti) +
              " reference images. increase_ref_index=" +
              (gen.increaseRefIndex
                   ? std::string("true (distinct RoPE slots per ref -- use "
                                 "when the text encoder supports vision "
                                 "tokens, e.g. Qwen-Image-Edit)")
                   : std::string("false (refs tile into one coordinate "
                                 "space -- visual feature fusion; CLI "
                                 "default, recommended for FLUX2-klein)")));
      // clang-format on

      genParams.ref_images = refImgs->data();
      genParams.ref_images_count = static_cast<int>(nMulti);
      genParams.auto_resize_ref_image = gen.autoResizeRefImage;
      // See SdGenConfig::increaseRefIndex for semantics. For FLUX2-klein the
      // CLI default (false) is what produces visible fusion: both refs share
      // a RoPE slot and their features blend in attention. Setting true
      // tends to make one ref dominate.
      genParams.increase_ref_index = gen.increaseRefIndex;
      // Fall through to the generate_image() call below.
    } else {
      // -- Single-image path (existing behaviour) --------------------------
      if (!job.initImageBytes.empty()) {
        initPng = job.initImageBytes;
      } else if (auto it = v.get<picojson::object>().find("init_image_bytes");
                 it != v.get<picojson::object>().end() &&
                 it->second.is<picojson::array>()) {
        const auto& arr = it->second.get<picojson::array>();
        initPng.reserve(arr.size());
        for (const auto& el : arr)
          initPng.push_back(static_cast<uint8_t>(el.get<double>()));
      }
      if (!initPng.empty())
        initImg = decodePng(initPng);

      if (!initImg.data)
        throw StatusError(
            general_error::InvalidArgument,
            "img2img: failed to decode init_image (corrupt or unsupported "
            "format)");

      const int imgW = static_cast<int>(initImg.width);
      const int imgH = static_cast<int>(initImg.height);

      if (isFluxFamily) {
        // FLUX in-context conditioning: ref_images handles its own resizing
        // via auto_resize_ref_image, so only override genParams dimensions
        // when they are still at the 512x512 default.
        if (gen.width == 512 && gen.height == 512) {
          genParams.width = imgW;
          genParams.height = imgH;
        }
        gen.width = genParams.width;
        gen.height = genParams.height;

        QLOG_IF(
            qvac_lib_inference_addon_cpp::logger::Priority::INFO,
            "img2img: " + std::to_string(imgW) + "x" + std::to_string(imgH) +
                " -- FLUX in-context conditioning (ref_images, count=1)");

        genParams.ref_images = &initImg;
        genParams.ref_images_count = 1;
        genParams.auto_resize_ref_image = gen.autoResizeRefImage;
      } else {
        // SDEdit path -- the vcpkg version of generate_image() rounds
        // width/height UP to a spatial multiple (typically 8) before
        // creating tensors, then asserts init_image matches those aligned
        // dimensions.  We must align here too and resize the decoded image
        // if its pixel dimensions aren't already a multiple of 8.
        constexpr int kAlign = 8;
        const int alignedW = (imgW + kAlign - 1) / kAlign * kAlign;
        const int alignedH = (imgH + kAlign - 1) / kAlign * kAlign;

        genParams.width = alignedW;
        genParams.height = alignedH;
        gen.width = alignedW;
        gen.height = alignedH;

        if (imgW != alignedW || imgH != alignedH) {
          QLOG_IF(
              qvac_lib_inference_addon_cpp::logger::Priority::INFO,
              "img2img: resizing " + std::to_string(imgW) + "x" +
                  std::to_string(imgH) + " -> " + std::to_string(alignedW) +
                  "x" + std::to_string(alignedH) + " (align to " +
                  std::to_string(kAlign) + ")");

          sd_image_t resized =
              image_utils::resizeSdImage(initImg, alignedW, alignedH);
          if (!resized.data)
            throw StatusError(
                general_error::InternalError,
                "Failed to resize init_image from " + std::to_string(imgW) +
                    "x" + std::to_string(imgH) + " to " +
                    std::to_string(alignedW) + "x" + std::to_string(alignedH));
          free(initImg.data);
          initImg = resized;
        }

        QLOG_IF(
            qvac_lib_inference_addon_cpp::logger::Priority::INFO,
            "img2img: " + std::to_string(alignedW) + "x" +
                std::to_string(alignedH) + " -- SDEdit (init_image, strength=" +
                std::to_string(gen.strength) + ")");

        genParams.init_image = initImg;

        // The vcpkg version of generate_image() unconditionally calls
        // sd_image_to_ggml_tensor() on mask_image (even when no mask was
        // provided), which asserts mask_image dimensions match the tensor.
        // Provide an all-white mask (= denoise everywhere) to satisfy it.
        if (!genParams.mask_image.data) {
          const size_t maskSize =
              static_cast<size_t>(alignedW) * static_cast<size_t>(alignedH);
          auto* maskData = static_cast<uint8_t*>(malloc(maskSize));
          if (!maskData)
            throw StatusError(
                general_error::InternalError,
                "Failed to allocate " + std::to_string(maskSize) +
                    " bytes for SDEdit mask (" + std::to_string(alignedW) +
                    "x" + std::to_string(alignedH) + ")");
          memset(maskData, 255, maskSize);
          genParams.mask_image = {
              static_cast<uint32_t>(alignedW),
              static_cast<uint32_t>(alignedH),
              1,
              maskData};
        }
      } // end SDEdit else
    } // end single-image else (nMulti == 0)
  } // end gen.mode == "img2img"

  // -- Generate --------------------------------------------------------------
  const auto t0 = std::chrono::steady_clock::now();

  SdImageBatch results(
      generate_image(sdCtx_.get(), &genParams), gen.batchCount);

  if (initImg.data) {
    free(initImg.data);
  }
  if (genParams.mask_image.data) {
    free(genParams.mask_image.data);
  }

  const bool wasCancelled = cancelRequested_.load();

  int outputCount = 0;
  for (int i = 0; i < results.count(); ++i) {
    if (results[i].data && !wasCancelled) {
      auto png = encodeToPng(results[i]);
      if (!png.empty() && job.outputCallback) {
        job.outputCallback(png);
        ++outputCount;
      }
    }
    results.release(
        i); // free pixel buffer immediately; destructor handles the rest
  }

  // If cancelled, propagate as an exception so JobRunner emits
  // queueException (error path), not queueResult + queueJobEnded.
  //
  // This intentionally differs from the LLM addon, which returns normally
  // on cancel (partial text output is still useful).  Diffusion produces no
  // partial images, so a "successful" completion with output_count=0 would
  // be misleading -- throwing gives the JS caller an explicit cancel signal.
  if (wasCancelled) {
    throw std::runtime_error("Job cancelled");
  }

  const auto t1 = std::chrono::steady_clock::now();

  // -- Accumulate cumulative counters -----------------------------------------
  const int64_t genMsI = static_cast<int64_t>(
      std::chrono::duration<double, std::milli>(t1 - t0).count());
  stats_.totalGenerationMs += genMsI;
  stats_.totalWallMs += genMsI;
  stats_.totalSteps += gen.steps;
  stats_.totalGenerations++;
  stats_.totalImages += outputCount;
  stats_.totalPixels +=
      static_cast<int64_t>(gen.width) * gen.height * outputCount;

  // -- Build stats for runtimeStats() -----------------------------------------
  // Stats are stored and emitted via queueJobEnded() -> runtimeStats().
  // process() returns std::any{} (empty) so images delivered via
  // outputCallback are not duplicated as a queueResult event.
  //
  // Only primitive (non-derivable) values are reported. Callers can compute
  // rates such as stepsPerSecond = totalSteps / (totalWallMs / 1000.0).
  lastStats_.clear();

  lastStats_.emplace_back("modelLoadMs", stats_.modelLoadMs);
  lastStats_.emplace_back("generationMs", genMsI);
  lastStats_.emplace_back("totalGenerationMs", stats_.totalGenerationMs);
  lastStats_.emplace_back("totalWallMs", stats_.totalWallMs);

  lastStats_.emplace_back("totalSteps", stats_.totalSteps);
  lastStats_.emplace_back("totalGenerations", stats_.totalGenerations);
  lastStats_.emplace_back("totalImages", stats_.totalImages);
  lastStats_.emplace_back("totalPixels", stats_.totalPixels);

  lastStats_.emplace_back("width", static_cast<int64_t>(gen.width));
  lastStats_.emplace_back("height", static_cast<int64_t>(gen.height));
  lastStats_.emplace_back("seed", gen.seed);

  // Return empty -- images are already delivered via outputCallback,
  // and stats are emitted by queueJobEnded() -> runtimeStats().
  return std::any{};
}

// ---------------------------------------------------------------------------
// cancel / runtimeStats
// ---------------------------------------------------------------------------

void SdModel::cancel() const { cancelRequested_.store(true); }

qvac_lib_inference_addon_cpp::RuntimeStats SdModel::runtimeStats() const {
  return lastStats_;
}

// ---------------------------------------------------------------------------
// PNG encode / decode (stb_image / stb_image_write)
// ---------------------------------------------------------------------------

std::vector<uint8_t> SdModel::encodeToPng(const sd_image_t& img) {
  std::vector<uint8_t> out;
  auto writeCallback = [](void* ctx, void* data, int size) {
    auto* vec = static_cast<std::vector<uint8_t>*>(ctx);
    vec->insert(
        vec->end(),
        static_cast<const uint8_t*>(data),
        static_cast<const uint8_t*>(data) + size);
  };
  stbi_write_png_to_func(
      writeCallback,
      &out,
      static_cast<int>(img.width),
      static_cast<int>(img.height),
      static_cast<int>(img.channel),
      img.data,
      static_cast<int>(img.width * img.channel));
  return out;
}

sd_image_t SdModel::decodePng(const std::vector<uint8_t>& pngBytes) {
  if (pngBytes.empty())
    return sd_image_t{};
  int w = 0, h = 0, c = 0;
  uint8_t* data = stbi_load_from_memory(
      pngBytes.data(), static_cast<int>(pngBytes.size()), &w, &h, &c, 3);
  if (!data)
    return sd_image_t{};
  return sd_image_t{
      static_cast<uint32_t>(w), static_cast<uint32_t>(h), 3, data};
}

// ---------------------------------------------------------------------------
// Log callback
// ---------------------------------------------------------------------------

void SdModel::sdLogCallback(
    sd_log_level_t level, const char* text, void* /*userData*/) {
  namespace lg = qvac_lib_inference_addon_cpp::logger;
  lg::Priority priority;
  switch (level) {
  case SD_LOG_DEBUG:
    priority = lg::Priority::DEBUG;
    break;
  case SD_LOG_INFO:
    priority = lg::Priority::INFO;
    break;
  case SD_LOG_WARN:
    priority = lg::Priority::WARNING;
    break;
  case SD_LOG_ERROR:
    priority = lg::Priority::ERROR;
    break;
  default:
    priority = lg::Priority::ERROR;
    break;
  }
  QLOG_IF(priority, std::string(text ? text : ""));
}
