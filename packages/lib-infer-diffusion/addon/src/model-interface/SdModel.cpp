#include "SdModel.hpp"

#include <chrono>
#include <cstring>
#include <sstream>

#define STB_IMAGE_IMPLEMENTATION
#include <stb_image.h>
#define STB_IMAGE_WRITE_IMPLEMENTATION
#include <picojson/picojson.h>
#include <qvac-lib-inference-addon-cpp/Errors.hpp>
#include <qvac-lib-inference-addon-cpp/Logger.hpp>
#include <stb_image_write.h>

#include "utils/LoggingMacros.hpp"

using namespace qvac_lib_inference_addon_cpp;
using namespace qvac_errors;

// ---------------------------------------------------------------------------
// Thread-local progress context — sd progress callbacks are process-global,
// so we park the current job pointer in TLS to route progress back.
// ---------------------------------------------------------------------------
namespace {

struct ProgressCtx {
  const SdModel::GenerationJob* job = nullptr;
  std::chrono::steady_clock::time_point startTime;
};

thread_local ProgressCtx tl_progressCtx;

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

} // namespace

// ---------------------------------------------------------------------------
// Constructor — stores config, allocates nothing
// ---------------------------------------------------------------------------

SdModel::SdModel(qvac_lib_inference_addon_sd::SdCtxConfig config)
    : config_(std::move(config)), sdCtx_(nullptr, &free_sd_ctx) {

  sd_set_log_callback(SdModel::sdLogCallback, nullptr);
}

// ---------------------------------------------------------------------------
// Destructor — delegates to unload()
// ---------------------------------------------------------------------------

SdModel::~SdModel() { unload(); }

// ---------------------------------------------------------------------------
// load() — maps SdCtxConfig → sd_ctx_params_t, then calls new_sd_ctx()
// ---------------------------------------------------------------------------

void SdModel::load() {
  if (isLoaded())
    return;

  sd_ctx_params_t params{};
  sd_ctx_params_init(&params);

  // ── Model paths ────────────────────────────────────────────────────────────
  // For FLUX.2 [klein] the GGUF contains only diffusion weights with no SD
  // version metadata KV pairs, so we must use diffusion_model_path.
  // Classic all-in-one SD1.x / SDXL checkpoints use model_path.
  params.model_path =
      config_.modelPath.empty() ? nullptr : config_.modelPath.c_str();
  params.diffusion_model_path = config_.diffusionModelPath.empty()
                                    ? nullptr
                                    : config_.diffusionModelPath.c_str();
  params.clip_l_path =
      config_.clipLPath.empty() ? nullptr : config_.clipLPath.c_str();
  params.clip_g_path =
      config_.clipGPath.empty() ? nullptr : config_.clipGPath.c_str();
  params.t5xxl_path =
      config_.t5XxlPath.empty() ? nullptr : config_.t5XxlPath.c_str();
  params.llm_path = config_.llmPath.empty() ? nullptr : config_.llmPath.c_str();
  params.vae_path = config_.vaePath.empty() ? nullptr : config_.vaePath.c_str();
  params.taesd_path =
      config_.taesdPath.empty() ? nullptr : config_.taesdPath.c_str();

  // ── Compute ────────────────────────────────────────────────────────────────
  params.n_threads = config_.nThreads;
  params.flash_attn = config_.flashAttn;
  params.diffusion_flash_attn = config_.diffusionFlashAttn;

  // ── Memory management ─────────────────────────────────────────────────────
  params.enable_mmap = config_.mmap;
  params.offload_params_to_cpu = config_.offloadToCpu;
#if defined(__APPLE__)
  // The ggml Metal backend does not fully support GGML_OP_NORM for
  // non-contiguous tensors (the CLIP text encoder hits this path).
  // Force CLIP to CPU on Apple to avoid a Metal encoder abort.
  params.keep_clip_on_cpu = true;
#else
  params.keep_clip_on_cpu = config_.keepClipOnCpu;
#endif
  params.keep_vae_on_cpu = config_.keepVaeOnCpu;

  // ── Precision ─────────────────────────────────────────────────────────────
  params.wtype = config_.wtype;
  params.tensor_type_rules = config_.tensorTypeRules.empty()
                                 ? nullptr
                                 : config_.tensorTypeRules.c_str();

  // ── Sampling RNG ──────────────────────────────────────────────────────────
  params.rng_type = config_.rngType;
  params.sampler_rng_type = config_.samplerRngType;

  // ── Prediction type / LoRA ────────────────────────────────────────────────
  params.prediction = config_.prediction;
  params.lora_apply_mode = config_.loraApplyMode;

  // ── Convolution options ───────────────────────────────────────────────────
  params.diffusion_conv_direct = config_.diffusionConvDirect;
  params.vae_conv_direct = config_.vaeConvDirect;
  params.circular_x = config_.circularX;
  params.circular_y = config_.circularY;
  params.force_sdxl_vae_conv_scale = config_.forceSDXLVaeConvScale;

  // ── Internal ──────────────────────────────────────────────────────────────
  params.free_params_immediately = config_.freeParamsImmediately;

  sd_ctx_t* raw = new_sd_ctx(&params);
  if (!raw) {
    const std::string path = config_.diffusionModelPath.empty()
                                 ? config_.modelPath
                                 : config_.diffusionModelPath;
    throw StatusError(
        general_error::InternalError,
        "SdModel::load() failed — could not create stable-diffusion context. "
        "Check model path and format: " +
            path);
  }

  sdCtx_.reset(raw);
}

// ---------------------------------------------------------------------------
// unload() — releases the sd_ctx and all associated GPU/CPU memory
// ---------------------------------------------------------------------------

void SdModel::unload() {
  if (!isLoaded())
    return;
  sdCtx_.reset(); // calls free_sd_ctx via custom deleter
  lastStats_.clear();
  cancelRequested_.store(false);
}

// ---------------------------------------------------------------------------
// process() — applies SdGenHandlers to JSON params, then calls generate_image
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

  // ── Parse JSON params ─────────────────────────────────────────────────────
  picojson::value v;
  const std::string parseErr = picojson::parse(v, job.paramsJson);
  if (!parseErr.empty())
    throw StatusError(
        general_error::InvalidArgument,
        "Failed to parse generation params JSON: " + parseErr);
  if (!v.is<picojson::object>())
    throw StatusError(
        general_error::InvalidArgument, "Params must be a JSON object");

  // ── Build SdGenConfig from handlers ───────────────────────────────────────
  qvac_lib_inference_addon_sd::SdGenConfig gen{};
  qvac_lib_inference_addon_sd::applySdGenHandlers(
      gen, v.get<picojson::object>());

  if (gen.mode != "txt2img" && gen.mode != "img2img")
    throw StatusError(
        general_error::InvalidArgument,
        "Unsupported mode: '" + gen.mode +
            "'. Only txt2img and img2img are supported.");

  // ── Build sd_img_gen_params_t ─────────────────────────────────────────────
  sd_img_gen_params_t genParams{};
  sd_img_gen_params_init(&genParams);

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

  // ── VAE tiling ────────────────────────────────────────────────────────────
  genParams.vae_tiling_params.enabled = gen.vaeTiling;
  genParams.vae_tiling_params.tile_size_x = gen.vaeTileSizeX;
  genParams.vae_tiling_params.tile_size_y = gen.vaeTileSizeY;
  genParams.vae_tiling_params.target_overlap = gen.vaeTileOverlap;

  // ── Step-caching ──────────────────────────────────────────────────────────
  sd_cache_params_init(&genParams.cache);
  genParams.cache.mode = gen.cacheMode;
  if (gen.cacheThreshold > 0.0f)
    genParams.cache.reuse_threshold = gen.cacheThreshold;
  if (gen.cacheStart > 0.0f)
    genParams.cache.start_percent = gen.cacheStart;
  if (gen.cacheEnd > 0.0f)
    genParams.cache.end_percent = gen.cacheEnd;

  // ── img2img init image (bytes passed as JSON array) ───────────────────────
  sd_image_t initImg{};
  std::vector<uint8_t> initPng;

  if (gen.mode == "img2img") {
    if (auto it = v.get<picojson::object>().find("init_image_bytes");
        it != v.get<picojson::object>().end() &&
        it->second.is<picojson::array>()) {
      const auto& arr = it->second.get<picojson::array>();
      initPng.reserve(arr.size());
      for (const auto& el : arr)
        initPng.push_back(static_cast<uint8_t>(el.get<double>()));
    }
    if (!initPng.empty())
      initImg = decodePng(initPng);
  }
  genParams.init_image = initImg;

  // ── Generate ──────────────────────────────────────────────────────────────
  const auto t0 = std::chrono::steady_clock::now();

  sd_image_t* results = generate_image(sdCtx_.get(), &genParams);

  if (initImg.data)
    free(initImg.data);

  int outputCount = 0;
  if (results) {
    for (int i = 0; i < gen.batchCount; ++i) {
      if (results[i].data && !cancelRequested_.load()) {
        auto png = encodeToPng(results[i]);
        if (!png.empty() && job.outputCallback) {
          job.outputCallback(png);
          ++outputCount;
        }
        free(results[i].data);
      }
    }
    free(results);
  }

  const auto t1 = std::chrono::steady_clock::now();
  const double genMs =
      std::chrono::duration<double, std::milli>(t1 - t0).count();

  lastStats_.clear();
  lastStats_.push_back({"generation_time", genMs});
  lastStats_.push_back({"steps", static_cast<int64_t>(gen.steps)});
  lastStats_.push_back({"width", static_cast<int64_t>(gen.width)});
  lastStats_.push_back({"height", static_cast<int64_t>(gen.height)});
  lastStats_.push_back({"output_count", static_cast<int64_t>(outputCount)});

  tl_progressCtx.job = nullptr;
  sd_set_progress_callback(nullptr, nullptr);

  return lastStats_;
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
