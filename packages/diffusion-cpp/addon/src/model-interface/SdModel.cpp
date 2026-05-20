#include "SdModel.hpp"

#include <chrono>
#include <cstdlib>
#include <cstring>
#include <sstream>
#include <utility>
#include <vector>

#include <inference-addon-cpp/Errors.hpp>
#include <inference-addon-cpp/Logger.hpp>
#include <picojson/picojson.h>

#include "utils/AviWriter.hpp"
#include "utils/BackendLoader.hpp"
#include "utils/BackendSelection.hpp"
#include "utils/ImageCodec.hpp"
#include "utils/ImageUtils.hpp"
#include "utils/LoggingMacros.hpp"
#include "utils/SdVideoFrames.hpp"

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

// NOLINTBEGIN(cppcoreguidelines-avoid-non-const-global-variables,bugprone-throwing-static-initialization)
thread_local ProgressCtx g_progressCtx;
// Thread-local model pointer for abort callback routing -- same pattern as
// g_progressCtx for progress.  Avoids relying on the process-global
// sd_abort_cb_data when multiple SdModel instances could coexist.
thread_local const SdModel* g_abortModel = nullptr;
// NOLINTEND(cppcoreguidelines-avoid-non-const-global-variables,bugprone-throwing-static-initialization)

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

void sdProgressCallback(int step, int steps, float /*time*/, void* /*data*/) {
  if (g_progressCtx.job == nullptr || !g_progressCtx.job->progressCallback) {
    return;
  }

  const auto elapsed =
      std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::steady_clock::now() - g_progressCtx.startTime)
          .count();

  std::ostringstream oss;
  oss << R"({"step":)" << step << R"(,"total":)" << steps << R"(,"elapsed_ms":)"
      << elapsed << "}";

  g_progressCtx.job->progressCallback(oss.str());
}

// Abort callback -- wired into sd_set_abort_callback() so that
// generate_image() can be interrupted mid-denoising.
// Reads from thread-local g_abortModel (not the global sd_abort_cb_data)
// to avoid concurrency issues when multiple SdModel instances coexist.
bool sdAbortCallback(void* /*data*/) {
  return (g_abortModel != nullptr) && g_abortModel->isCancelRequested();
}

// RAII wrapper for the sd_image_t* array returned by generate_image().
// Frees each image's pixel buffer and the array itself on destruction,
// even if an exception is thrown mid-iteration (e.g. in PNG encoding or
// outputCallback).  Call release(i) after processing image i to free
// its pixel buffer immediately rather than waiting until destruction.
class SdImageBatch {
public:
  SdImageBatch(sd_image_t* data, int count) : data_(data), count_(count) {}
  ~SdImageBatch() {
    if (data_ == nullptr) {
      return;
    }
    for (int idx = 0; idx < count_; ++idx) {
      // NOLINTNEXTLINE(cppcoreguidelines-no-malloc,cppcoreguidelines-owning-memory,cppcoreguidelines-pro-bounds-pointer-arithmetic)
      free(data_[idx].data);
    }
    // NOLINTNEXTLINE(cppcoreguidelines-no-malloc,cppcoreguidelines-owning-memory)
    free(data_);
  }

  SdImageBatch(const SdImageBatch&) = delete;
  SdImageBatch& operator=(const SdImageBatch&) = delete;
  SdImageBatch(SdImageBatch&&) = delete;
  SdImageBatch& operator=(SdImageBatch&&) = delete;

  [[nodiscard]] int count() const { return count_; }
  [[nodiscard]] const sd_image_t& operator[](int idx) const {
    if (data_ == nullptr) {
      throw std::runtime_error("SdImageBatch: null data");
    }
    // NOLINTNEXTLINE(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    return data_[idx];
  }

  // Release pixel buffer for image idx immediately after it has been consumed.
  void release(int idx) {
    if (data_ == nullptr) {
      return;
    }
    // NOLINTNEXTLINE(cppcoreguidelines-no-malloc,cppcoreguidelines-owning-memory,cppcoreguidelines-pro-bounds-pointer-arithmetic)
    free(data_[idx].data);
    // NOLINTNEXTLINE(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    data_[idx].data = nullptr;
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
  item.multiplier = 1.0F;
  item.path = prepared.paths.back().c_str();
  prepared.items.push_back(item);

  return prepared;
}

} // namespace

// ---------------------------------------------------------------------------
// Constructor -- stores config, allocates nothing
// ---------------------------------------------------------------------------

SdModel::SdModel(qvac_lib_inference_addon_sd::SdCtxConfig config)
    : config_(std::move(config)), sdCtx_(nullptr, &free_sd_ctx),
      upscaler_(qvac_lib_inference_addon_sd::makeUpscalerConfig(config_)) {

  sd_set_log_callback(qvac_lib_inference_addon_sd::sdLogCallback, nullptr);
}

// ---------------------------------------------------------------------------
// Destructor -- releases the sd_ctx and all associated GPU/CPU memory
// ---------------------------------------------------------------------------

SdModel::~SdModel() = default;

// ---------------------------------------------------------------------------
// load() -- maps SdCtxConfig -> sd_ctx_params_t, then calls new_sd_ctx()
// ---------------------------------------------------------------------------

void SdModel::load() {
  if (isLoaded()) {
    return;
  }

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
  // Classic all-in-one SD2.x / SDXL checkpoints use model_path.
  auto optPath = [](const std::string& str) -> const char* {
    return str.empty() ? nullptr : str.c_str();
  };
  params.model_path = optPath(config_.modelPath);
  params.diffusion_model_path = optPath(config_.diffusionModelPath);
  params.high_noise_diffusion_model_path =
      optPath(config_.highNoiseDiffusionModelPath);
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
  qvac_lib_inference_addon_sd::loadBackendModulesOnce(config_.backendsDir);

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

  // NOLINTNEXTLINE(cppcoreguidelines-avoid-do-while)
  QLOG_IF(
      qvac_lib_inference_addon_cpp::logger::Priority::INFO,
      "Preferred backend passed to stable-diffusion: " +
          preferredBackendToString(params.preferred_gpu_backend) + " (" +
          std::to_string(static_cast<int>(params.preferred_gpu_backend)) + ")");

#ifdef __APPLE__
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
  if (raw == nullptr) {
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
// process() -- parses mode, sets up callbacks + guard, dispatches to
// processImage() (generate_image) or processVideo() (generate_video).
// ---------------------------------------------------------------------------

// NOLINTNEXTLINE(readability-function-cognitive-complexity)
std::any SdModel::process(const std::any& input) {
  if (!isLoaded()) {
    throw StatusError(
        general_error::InternalError,
        "SdModel::process() called before load()");
  }

  const auto& job = std::any_cast<const GenerationJob&>(input);

  cancelRequested_.store(false);
  g_progressCtx.job = &job;
  g_progressCtx.startTime = std::chrono::steady_clock::now();
  sd_set_progress_callback(sdProgressCallback, nullptr);
  g_abortModel = this;
  sd_set_abort_callback(sdAbortCallback, nullptr);

  // Scope guard: clear process-global callbacks on any exit path (including
  // early exceptions from parsing/validation before generate_image runs).
  auto clearCallbacks = [&]() {
    g_progressCtx.job = nullptr;
    g_abortModel = nullptr;
    sd_set_progress_callback(nullptr, nullptr);
    sd_set_abort_callback(nullptr, nullptr);
  };
  struct CallbackGuard {
    std::function<void()> fn;
    explicit CallbackGuard(std::function<void()> callback) noexcept
        : fn(std::move(callback)) {}
    CallbackGuard(const CallbackGuard&) = delete;
    CallbackGuard& operator=(const CallbackGuard&) = delete;
    CallbackGuard(CallbackGuard&&) = delete;
    CallbackGuard& operator=(CallbackGuard&&) = delete;
    ~CallbackGuard() noexcept {
      try {
        fn();
      } catch (...) { // NOLINT(bugprone-empty-catch)
      }
    }
  } guard(clearCallbacks);

  // -- Parse JSON params -----------------------------------------------------
  picojson::value jsonRoot;
  const std::string parseErr = picojson::parse(jsonRoot, job.paramsJson);
  if (!parseErr.empty()) {
    throw StatusError(
        general_error::InvalidArgument,
        "Failed to parse generation params JSON: " + parseErr);
  }
  if (!jsonRoot.is<picojson::object>()) {
    throw StatusError(
        general_error::InvalidArgument, "Params must be a JSON object");
  }

  // -- Peek top-level mode to choose dispatch branch -------------------------
  // Default is "txt2img" for backwards compatibility: a JSON payload that
  // omits "mode" keeps behaving as an image generation job.
  std::string mode = "txt2img";
  const auto &obj = jsonRoot.get<picojson::object>();
  if (auto it = obj.find("mode"); it != obj.end()) {
    if (!it->second.is<std::string>())
      throw StatusError(general_error::InvalidArgument,
                        "mode must be a string");
    mode = it->second.get<std::string>();
  }

  const bool isVideo =
      (mode == "txt2vid" || mode == "img2vid" || mode == "flf2vid");
  if (isVideo) {
    return processVideo(job, jsonRoot);
  }
  return processImage(job, jsonRoot);
}

// ---------------------------------------------------------------------------
// processImage() -- applies SdGenHandlers, fills sd_img_gen_params_t, runs
// generate_image(). Assumes callbacks + guard are already set up by
// process().
// ---------------------------------------------------------------------------

std::any SdModel::processImage(const GenerationJob &job,
                               const picojson::value &v) {
  // -- Build SdGenConfig from handlers ---------------------------------------
  qvac_lib_inference_addon_sd::SdGenConfig gen{};
  qvac_lib_inference_addon_sd::applySdGenHandlers(gen,
                                                  v.get<picojson::object>());

  if (gen.mode != "txt2img" && gen.mode != "img2img") {
    throw StatusError(
        general_error::InvalidArgument,
        "Unsupported mode: '" + gen.mode + "'. Supported: txt2img, img2img.");
  }

  if (gen.upscale && config_.esrganPath.empty()) {
    throw StatusError(
        general_error::InvalidArgument,
        "ESRGAN upscale requested but files.esrgan was not provided");
  }

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
      gen.imgCfgScale < 0.0F ? gen.cfgScale : gen.imgCfgScale;
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
  if (gen.cacheThreshold > 0.0F) {
    genParams.cache.reuse_threshold = gen.cacheThreshold;
  }
  if (gen.cacheStart > 0.0F) {
    genParams.cache.start_percent = gen.cacheStart;
  }
  if (gen.cacheEnd > 0.0F) {
    genParams.cache.end_percent = gen.cacheEnd;
  }

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
  //   All other models (SD2.x, SDXL, SD3):
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
  auto refImgsDeleter = [](std::vector<sd_image_t>* ptr) {
    if (ptr == nullptr) {
      return;
    }
    for (auto& img : *ptr) {
      if (img.data != nullptr) {
        // NOLINTNEXTLINE(cppcoreguidelines-no-malloc,cppcoreguidelines-owning-memory)
        free(img.data);
        img.data = nullptr;
      }
    }
    // NOLINTNEXTLINE(cppcoreguidelines-owning-memory)
    delete ptr;
  };
  std::unique_ptr<std::vector<sd_image_t>, decltype(refImgsDeleter)> refImgs(
      new std::vector<sd_image_t>(), refImgsDeleter); // NOLINT

  if (gen.mode == "img2img") {
    const bool isFluxFamily = config_.prediction == FLUX2_FLOW_PRED;
    const bool isFlux2 = config_.prediction == FLUX2_FLOW_PRED;
    const size_t nMulti = job.initImagesBytes.size();

    // -- Input validation: mutual exclusion + FLUX-only for multi -----------
    //
    // These checks mirror the JS-layer validation in index.js but are
    // duplicated here so the C++ API stays safe when called directly from
    // unit tests or bindings that bypass index.js.
    if (!job.initImageBytes.empty() && nMulti > 0) {
      throw StatusError(
          general_error::InvalidArgument,
          "img2img: init_image and init_images are mutually exclusive -- "
          "pick one. Use init_images (with FLUX2) for multi-reference "
          "fusion, or init_image for single-image conditioning.");
    }

    if (nMulti > 0 && !isFlux2) {
      throw StatusError(
          general_error::InvalidArgument,
          "img2img: init_images (multi-reference fusion) requires a FLUX2 "
          "model with prediction='flux2_flow'. The current model does not "
          "support @image1/@imageN in-context references.");
    }

    // -- Multi-image (FLUX2 "fusion" mode) ---------------------------------
    if (nMulti > 0) {
      refImgs->reserve(nMulti);
      for (size_t idx = 0; idx < nMulti; ++idx) {
        // NOLINTNEXTLINE(cppcoreguidelines-pro-bounds-avoid-unchecked-container-access)
        if (job.initImagesBytes[idx].empty()) {
          throw StatusError(
              general_error::InvalidArgument,
              "img2img: init_images[" + std::to_string(idx) +
                  "] is empty -- every reference must be a non-empty "
                  "PNG/JPEG buffer.");
        }

        // NOLINTNEXTLINE(cppcoreguidelines-pro-bounds-avoid-unchecked-container-access)
        sd_image_t decoded = image_codec::decodeImage(job.initImagesBytes[idx]);
        if (decoded.data == nullptr) {
          throw StatusError(
              general_error::InvalidArgument,
              "img2img: failed to decode init_images[" + std::to_string(idx) +
                  "] (corrupt or unsupported format; supported: PNG, JPEG)");
        }
        refImgs->push_back(decoded);
      }

      // index.js defaults FLUX img2img (fusion and single-ref) to 1024×1024
      // when the caller omits width/height, so addon.js::_fillDimsFromImage
      // is a no-op for that path. Direct C++ callers should supply explicit
      // dimensions; otherwise the SdGenConfig 512×512 default is used.
      // auto_resize_ref_image handles the remaining refs.

      // clang-format off
      // NOTE: Homebrew and apt.llvm.org builds of clang-format-19 disagree on
      // whether the std::string(...) branches of this ternary should hang the
      // call open-paren on its own line. Pinning the layout here keeps local
      // and CI bit-for-bit.
      // NOLINTNEXTLINE(cppcoreguidelines-avoid-do-while)
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
      } else {
        const auto &jsonObj = v.get<picojson::object>();
        auto initBytesIt = jsonObj.find("init_image_bytes");
        if (initBytesIt != jsonObj.end() &&
            initBytesIt->second.is<picojson::array>()) {
          const auto& arr = initBytesIt->second.get<picojson::array>();
          initPng.reserve(arr.size());
          for (const auto& elem : arr) {
            initPng.push_back(static_cast<uint8_t>(elem.get<double>()));
          }
        }
      }
      if (!initPng.empty()) {
        initImg = image_codec::decodeImage(initPng);
      }

      if (initImg.data == nullptr) {
        throw StatusError(
            general_error::InvalidArgument,
            "img2img: failed to decode init_image (corrupt or unsupported "
            "format)");
      }

      const int imgW = static_cast<int>(initImg.width);
      const int imgH = static_cast<int>(initImg.height);

      if (isFluxFamily) {
        // genParams.width/height are already assigned from gen earlier in this
        // function. index.js defaults any missing FLUX img2img axis to 1024;
        // direct C++ callers should supply explicit dimensions, otherwise the
        // SdGenConfig 512×512 default is used.

        // NOLINTNEXTLINE(cppcoreguidelines-avoid-do-while)
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
          // NOLINTNEXTLINE(cppcoreguidelines-avoid-do-while)
          QLOG_IF(
              qvac_lib_inference_addon_cpp::logger::Priority::INFO,
              "img2img: resizing " + std::to_string(imgW) + "x" +
                  std::to_string(imgH) + " -> " + std::to_string(alignedW) +
                  "x" + std::to_string(alignedH) + " (align to " +
                  std::to_string(kAlign) + ")");

          sd_image_t resized =
              image_utils::resizeSdImage(initImg, alignedW, alignedH);
          if (resized.data == nullptr) {
            throw StatusError(
                general_error::InternalError,
                "Failed to resize init_image from " + std::to_string(imgW) +
                    "x" + std::to_string(imgH) + " to " +
                    std::to_string(alignedW) + "x" + std::to_string(alignedH));
          }
          // NOLINTNEXTLINE(cppcoreguidelines-no-malloc,cppcoreguidelines-owning-memory)
          free(initImg.data);
          initImg = resized;
        }

        // NOLINTNEXTLINE(cppcoreguidelines-avoid-do-while)
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
        if (genParams.mask_image.data == nullptr) {
          const size_t maskSize =
              static_cast<size_t>(alignedW) * static_cast<size_t>(alignedH);
          // NOLINTNEXTLINE(cppcoreguidelines-no-malloc,cppcoreguidelines-owning-memory)
          auto* maskData = static_cast<uint8_t*>(malloc(maskSize));
          if (maskData == nullptr) {
            throw StatusError(
                general_error::InternalError,
                "Failed to allocate " + std::to_string(maskSize) +
                    " bytes for SDEdit mask (" + std::to_string(alignedW) +
                    "x" + std::to_string(alignedH) + ")");
          }
          // NOLINTNEXTLINE(readability-magic-numbers,cppcoreguidelines-avoid-magic-numbers)
          memset(maskData, 255, maskSize);
          // NOLINTNEXTLINE(modernize-use-designated-initializers)
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
  const auto genStart = std::chrono::steady_clock::now();

  SdImageBatch results(
      generate_image(sdCtx_.get(), &genParams), gen.batchCount);

  if (initImg.data != nullptr) {
    // NOLINTNEXTLINE(cppcoreguidelines-no-malloc,cppcoreguidelines-owning-memory)
    free(initImg.data);
  }
  if (genParams.mask_image.data != nullptr) {
    // NOLINTNEXTLINE(cppcoreguidelines-no-malloc,cppcoreguidelines-owning-memory)
    free(genParams.mask_image.data);
  }

  int outputCount = 0;
  // RuntimeStats describe emitted PNGs. Keep generation dimensions as the
  // fallback so a failed encode/callback does not report an upscaled size.
  int64_t outputPixels = 0;
  auto statsWidth = static_cast<int64_t>(gen.width);
  auto statsHeight = static_cast<int64_t>(gen.height);
  bool wasCancelled = false;
  for (int idx = 0; idx < results.count(); ++idx) {
    if (cancelRequested_.load()) {
      wasCancelled = true;
      break;
    }

    // NOLINTNEXTLINE(cppcoreguidelines-pro-bounds-avoid-unchecked-container-access)
    if (results[idx].data != nullptr) {
      // NOLINTNEXTLINE(cppcoreguidelines-pro-bounds-avoid-unchecked-container-access)
      sd_image_t imageForOutput = results[idx];
      std::unique_ptr<uint8_t, image_codec::FreeDeleter> upscaledData(nullptr);

      if (gen.upscale) {
        // NOLINTNEXTLINE(cppcoreguidelines-pro-bounds-avoid-unchecked-container-access)
        sd_image_t upscaled = upscaleImage(results[idx], gen.upscaleRepeats);
        imageForOutput = upscaled;
        upscaledData.reset(upscaled.data);
      }

      if (cancelRequested_.load()) {
        wasCancelled = true;
      } else {
        auto png = image_codec::encodeToPng(imageForOutput);
        if (!png.empty() && static_cast<bool>(job.outputCallback)) {
          const auto outputWidth = static_cast<int64_t>(imageForOutput.width);
          const auto outputHeight = static_cast<int64_t>(imageForOutput.height);
          job.outputCallback(png);
          ++outputCount;
          outputPixels += outputWidth * outputHeight;
          statsWidth = outputWidth;
          statsHeight = outputHeight;
        }
      }
    }
    results.release(
        idx); // free pixel buffer immediately; destructor handles the rest
    if (cancelRequested_.load()) {
      wasCancelled = true;
    }
    if (wasCancelled) {
      break;
    }
  }

  // If cancelled, propagate as an exception so JobRunner emits
  // queueException (error path), not queueResult + queueJobEnded.
  //
  // This intentionally differs from the LLM addon, which returns normally
  // on cancel (partial text output is still useful).  Diffusion produces no
  // partial images, so a "successful" completion with output_count=0 would
  // be misleading -- throwing gives the JS caller an explicit cancel signal.
  // We tag the StatusError with localCodeMsg="Cancelled" so the JS layer
  // can discriminate cancel from real internal failures via the status
  // code (codeString() == "[ General :: Cancelled ]") instead of
  // string-matching the exception message.
  //
  // Note: we use the 3-arg StatusError ctor with explicit addonId +
  // localCodeMsg instead of adding `Cancelled` to general_error's enum
  // so this PR doesn't have to touch the shared inference-addon-cpp
  // header (which would force a coordinated update across every other
  // package that pulls it in via vcpkg).
  if (wasCancelled) {
    throw StatusError(std::string(general_error::GeneralAddonId), "Cancelled",
                      "Job cancelled");
  }

  if (outputCount == 0) {
    throw StatusError(
        general_error::InternalError,
        "Image generation produced no output. The VAE decode likely failed "
        "(out of device memory). Try enabling vae_tiling in run() params.");
  }

  const auto genEnd = std::chrono::steady_clock::now();

  // -- Accumulate cumulative counters -----------------------------------------
  const int64_t genMsI = static_cast<int64_t>(
      std::chrono::duration<double, std::milli>(genEnd - genStart).count());
  stats_.totalGenerationMs += genMsI;
  stats_.totalWallMs += genMsI;
  stats_.totalSteps += gen.steps;
  stats_.totalGenerations++;
  stats_.totalImages += outputCount;
  stats_.totalPixels += outputPixels;

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

  lastStats_.emplace_back("width", statsWidth);
  lastStats_.emplace_back("height", statsHeight);
  lastStats_.emplace_back("seed", gen.seed);

  // Return empty -- images are already delivered via outputCallback,
  // and stats are emitted by queueJobEnded() -> runtimeStats().
  return std::any{};
}

// ---------------------------------------------------------------------------
// processVideo() -- applies SdVidGenHandlers, fills sd_vid_gen_params_t,
// runs generate_video(), encodes the returned sd_image_t* frames as an
// in-memory MJPG AVI via encodeFramesToAvi() and fires the outputCallback
// once. Optionally fan out per-frame PNGs to frameCallback.
//
// Assumes callbacks + guard are already set up by process().
// ---------------------------------------------------------------------------

std::any SdModel::processVideo(const GenerationJob &job,
                               const picojson::value &v) {
  // -- Build SdVidGenConfig from handlers ------------------------------------
  qvac_lib_inference_addon_sd::SdVidGenConfig vid{};
  qvac_lib_inference_addon_sd::applySdVidGenHandlers(vid,
                                                     v.get<picojson::object>());

  if (vid.mode != "txt2vid" && vid.mode != "img2vid" && vid.mode != "flf2vid")
    throw StatusError(general_error::InvalidArgument,
                      "processVideo: unsupported mode '" + vid.mode +
                          "' (expected txt2vid, img2vid, or flf2vid)");

  // -- Mode-vs-inputs invariants --------------------------------------------
  // These checks mirror the JS-layer validation but are duplicated here so
  // the C++ API stays safe when called directly from unit tests or bindings
  // that bypass the JS shim.
  if (vid.mode == "img2vid" && job.initImageBytes.empty())
    throw StatusError(
        general_error::InvalidArgument,
        "img2vid: init_image is required (the first frame to animate)");

  if (vid.mode == "flf2vid") {
    if (job.initImageBytes.empty())
      throw StatusError(general_error::InvalidArgument,
                        "flf2vid: init_image (first frame) is required");
    if (job.endImageBytes.empty())
      throw StatusError(general_error::InvalidArgument,
                        "flf2vid: end_image (last frame) is required");
  }

  if (!job.endImageBytes.empty() && vid.mode != "flf2vid")
    throw StatusError(general_error::InvalidArgument,
                      "end_image is only valid for mode='flf2vid', got mode='" +
                          vid.mode + "'");

  if (vid.mode == "txt2vid" && !job.initImageBytes.empty())
    throw StatusError(
        general_error::InvalidArgument,
        "txt2vid does not accept init_image; use img2vid or flf2vid instead");

  // -- Decode init / end / control-frame images -----------------------------
  // sd_image_t::data is allocated by stb_image via malloc(), so we wrap each
  // pixel buffer in unique_ptr with image_codec::FreeDeleter to guarantee
  // release on every exit path (including exceptions from generate_video()
  // or the AVI muxer). The sd_image_t structs themselves stay plain values
  // so we can pass them straight to the C ABI.
  sd_image_t initImg{};
  sd_image_t endImg{};
  std::vector<sd_image_t> controlFrames;

  using PixelBuffer = std::unique_ptr<uint8_t, image_codec::FreeDeleter>;
  PixelBuffer initData;
  PixelBuffer endData;
  std::vector<PixelBuffer> controlData;

  if (!job.initImageBytes.empty()) {
    initImg = image_codec::decodeImage(job.initImageBytes);
    if (!initImg.data)
      throw StatusError(general_error::InvalidArgument,
                        "processVideo: failed to decode init_image (corrupt or "
                        "unsupported format; supported: PNG, JPEG)");
    // Take ownership *before* the dimension check so a mismatch can't leak
    // the freshly-decoded pixel buffer (mirrors the control_frames path).
    initData.reset(initImg.data);
    // generate_video() takes a single (width, height) for the whole pipeline;
    // mixing an init_image of a different size with a width/height the user
    // declared elsewhere produces inconsistent frame data downstream. Reject
    // explicitly here -- consistent with the end_image / control_frames
    // checks below, all three compare against vid.width / vid.height as the
    // single source of truth for the video's final dimensions.
    if (static_cast<int>(initImg.width) != vid.width ||
        static_cast<int>(initImg.height) != vid.height)
      throw StatusError(general_error::InvalidArgument,
                        "processVideo: init_image dimensions " +
                            std::to_string(initImg.width) + "x" +
                            std::to_string(initImg.height) +
                            " do not match video dimensions " +
                            std::to_string(vid.width) + "x" +
                            std::to_string(vid.height));
  }

  if (!job.endImageBytes.empty()) {
    endImg = image_codec::decodeImage(job.endImageBytes);
    if (!endImg.data)
      throw StatusError(
          general_error::InvalidArgument,
          "processVideo: failed to decode end_image (corrupt or unsupported "
          "format; supported: PNG, JPEG)");
    endData.reset(endImg.data);
    if (static_cast<int>(endImg.width) != vid.width ||
        static_cast<int>(endImg.height) != vid.height)
      throw StatusError(
          general_error::InvalidArgument,
          "processVideo: end_image dimensions " + std::to_string(endImg.width) +
              "x" + std::to_string(endImg.height) +
              " do not match video dimensions " + std::to_string(vid.width) +
              "x" + std::to_string(vid.height));
  }

  if (!job.controlFramesBytes.empty()) {
    controlFrames.reserve(job.controlFramesBytes.size());
    controlData.reserve(job.controlFramesBytes.size());
    for (size_t i = 0; i < job.controlFramesBytes.size(); ++i) {
      sd_image_t decoded = image_codec::decodeImage(job.controlFramesBytes[i]);
      if (!decoded.data)
        throw StatusError(
            general_error::InvalidArgument,
            "processVideo: failed to decode control_frames[" +
                std::to_string(i) +
                "] (corrupt or unsupported format; supported: PNG, JPEG)");
      // Take ownership *before* the dimension check so a mismatch can't leak
      // the freshly-decoded pixel buffer.
      PixelBuffer owned(decoded.data);
      if (static_cast<int>(decoded.width) != vid.width ||
          static_cast<int>(decoded.height) != vid.height) {
        throw StatusError(general_error::InvalidArgument,
                          "processVideo: control_frames[" + std::to_string(i) +
                              "] dimensions " + std::to_string(decoded.width) +
                              "x" + std::to_string(decoded.height) +
                              " do not match video dimensions " +
                              std::to_string(vid.width) + "x" +
                              std::to_string(vid.height));
      }
      controlData.push_back(std::move(owned));
      controlFrames.push_back(decoded);
    }
  }

  // -- Build sd_vid_gen_params_t --------------------------------------------
  sd_vid_gen_params_t vidParams{};
  sd_vid_gen_params_init(&vidParams);

  vidParams.prompt = vid.prompt.c_str();
  vidParams.negative_prompt = vid.negativePrompt.c_str();
  vidParams.width = vid.width;
  vidParams.height = vid.height;
  vidParams.seed = vid.seed;
  vidParams.video_frames = vid.videoFrames;
  vidParams.strength = vid.strength;
  vidParams.vace_strength = vid.vaceStrength;
  vidParams.moe_boundary = vid.moeBoundary;

  if (initImg.data)
    vidParams.init_image = initImg;
  if (endImg.data)
    vidParams.end_image = endImg;
  if (!controlFrames.empty()) {
    vidParams.control_frames = controlFrames.data();
    vidParams.control_frames_size = static_cast<int>(controlFrames.size());
  }

  // Low-noise / only-expert sample params
  vidParams.sample_params.sample_method = vid.sampleMethod;
  vidParams.sample_params.scheduler = vid.scheduler;
  vidParams.sample_params.sample_steps = vid.sampleSteps;
  vidParams.sample_params.guidance.txt_cfg = vid.cfgScale;
  // Per-job flow_shift overrides ctx-level flowShift; 0.0 falls through to
  // the ctx default (SdCtxConfig::flowShift, which is infinity / embedded).
  if (vid.flowShift > 0.0f) {
    vidParams.sample_params.flow_shift = vid.flowShift;
  } else {
    vidParams.sample_params.flow_shift = config_.flowShift;
  }

  // High-noise expert sample params (Wan 2.2 only; ignored by the library
  // when highNoiseDiffusionModelPath is empty)
  vidParams.high_noise_sample_params.sample_method = vid.highNoiseSampleMethod;
  vidParams.high_noise_sample_params.scheduler = vid.highNoiseScheduler;
  vidParams.high_noise_sample_params.sample_steps = vid.highNoiseSteps;
  vidParams.high_noise_sample_params.guidance.txt_cfg = vid.highNoiseCfgScale;
  if (vid.highNoiseFlowShift > 0.0f) {
    vidParams.high_noise_sample_params.flow_shift = vid.highNoiseFlowShift;
  } else {
    vidParams.high_noise_sample_params.flow_shift = config_.flowShift;
  }

  // VAE tiling (strongly recommended for Wan)
  vidParams.vae_tiling_params.enabled = vid.vaeTiling;
  vidParams.vae_tiling_params.tile_size_x = vid.vaeTileSizeX;
  vidParams.vae_tiling_params.tile_size_y = vid.vaeTileSizeY;
  vidParams.vae_tiling_params.target_overlap = vid.vaeTileOverlap;

  // Step-caching
  sd_cache_params_init(&vidParams.cache);
  vidParams.cache.mode = vid.cacheMode;
  if (vid.cacheThreshold > 0.0f)
    vidParams.cache.reuse_threshold = vid.cacheThreshold;

  // -- Generate -------------------------------------------------------------
  const auto t0 = std::chrono::steady_clock::now();

  int numFramesOut = 0;
  qvac_lib_inference_addon_sd::SdVideoFrames frames(
      generate_video(sdCtx_.get(), &vidParams, &numFramesOut), numFramesOut);

  // If cancelled during the sampler, surface as an exception for the same
  // reason as the image path: a "successful" completion with zero frames
  // would be misleading. Typed Cancelled status (see image path above for
  // the 3-arg ctor rationale).
  auto throwCancelled = []() {
    throw StatusError(std::string(general_error::GeneralAddonId), "Cancelled",
                      "Job cancelled");
  };
  if (cancelRequested_.load()) {
    throwCancelled();
  }

  if (frames.empty())
    throw StatusError(general_error::InternalError,
                      "processVideo: generate_video() returned no frames");

  // -- Fan out per-frame PNGs (opt-in) --------------------------------------
  // PNG encoding for an 81-frame 832x480 video can take multiple seconds; we
  // re-check cancelRequested_ at the top of each iteration so a user pressing
  // cancel during the fan-out gets a prompt signal instead of waiting for
  // the AVI mux to finish.
  if (job.frameCallback) {
    for (int i = 0; i < frames.count(); ++i) {
      if (cancelRequested_.load())
        throwCancelled();
      if (!frames[i].data)
        continue;
      auto png = image_codec::encodeToPng(frames[i]);
      if (!png.empty()) {
        job.frameCallback(png, i, frames.count());
      }
    }
  }

  // One last cancellation check before the MJPG mux: encodeFramesToAvi can
  // also take multiple seconds on large videos, and it has no cancellation
  // hook of its own.
  if (cancelRequested_.load())
    throwCancelled();

  // -- Encode AVI and deliver ----------------------------------------------
  auto avi = qvac_lib_inference_addon_sd::encodeFramesToAvi(
      frames.data(), frames.count(), vid.fps);

  if (!avi.empty() && job.outputCallback) {
    job.outputCallback(avi);
  }

  const auto t1 = std::chrono::steady_clock::now();

  // -- Accumulate cumulative counters ---------------------------------------
  const int64_t genMsI = static_cast<int64_t>(
      std::chrono::duration<double, std::milli>(t1 - t0).count());
  stats_.totalGenerationMs += genMsI;
  stats_.totalWallMs += genMsI;
  // totalSteps accumulates both experts for Wan 2.2 runs; for Wan 2.1 the
  // high-noise expert isn't loaded, so highNoiseSteps goes to waste counting
  // here but isn't actually consumed. Keep it simple and sum both.
  stats_.totalSteps += vid.sampleSteps;
  if (!config_.highNoiseDiffusionModelPath.empty())
    stats_.totalSteps += vid.highNoiseSteps;
  stats_.totalGenerations++;
  stats_.totalVideos++;
  stats_.totalVideoFrames += frames.count();
  // Count pixels over all frames -- useful for megapixel/s rate derivation.
  stats_.totalPixels += static_cast<int64_t>(vid.width) *
                        static_cast<int64_t>(vid.height) * frames.count();

  // -- Build runtime stats --------------------------------------------------
  lastStats_.clear();
  lastStats_.emplace_back("modelLoadMs", stats_.modelLoadMs);
  lastStats_.emplace_back("generationMs", genMsI);
  lastStats_.emplace_back("totalGenerationMs", stats_.totalGenerationMs);
  lastStats_.emplace_back("totalWallMs", stats_.totalWallMs);
  lastStats_.emplace_back("totalSteps", stats_.totalSteps);
  lastStats_.emplace_back("totalGenerations", stats_.totalGenerations);
  lastStats_.emplace_back("totalImages", stats_.totalImages);
  lastStats_.emplace_back("totalPixels", stats_.totalPixels);
  lastStats_.emplace_back("totalVideos", stats_.totalVideos);
  lastStats_.emplace_back("totalVideoFrames", stats_.totalVideoFrames);
  lastStats_.emplace_back("width", static_cast<int64_t>(vid.width));
  lastStats_.emplace_back("height", static_cast<int64_t>(vid.height));
  lastStats_.emplace_back("seed", vid.seed);
  lastStats_.emplace_back("videoFrames", static_cast<int64_t>(frames.count()));
  lastStats_.emplace_back("fps", static_cast<int64_t>(vid.fps));

  return std::any{};
}

// ---------------------------------------------------------------------------
// cancel / runtimeStats
// ---------------------------------------------------------------------------

void SdModel::cancel() const { cancelRequested_.store(true); }

qvac_lib_inference_addon_cpp::RuntimeStats SdModel::runtimeStats() const {
  return lastStats_;
}

sd_image_t SdModel::upscaleImage(const sd_image_t& inputImage, int repeats) {
  return upscaler_.upscaleImage(
      inputImage, repeats, [this]() { return cancelRequested_.load(); });
}
