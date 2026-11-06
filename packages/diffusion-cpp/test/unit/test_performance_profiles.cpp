#include <filesystem>
#include <fstream>
#include <memory>

#include <ggml.h>
#include <gguf.h>
#include <gtest/gtest.h>

#include "handlers/SdVidGenHandlers.hpp"
#include "utils/PerformanceProfiles.hpp"

using namespace qvac_lib_inference_addon_sd;

namespace {
constexpr uint64_t GIB = uint64_t{1} << 30;
ProfileDevice device(ProfileApi api, ProfileGpu gpu) {
  return {api, gpu, 90 * GIB, 96 * GIB, 90 * GIB, 96 * GIB};
}
} // namespace

TEST(SdPerformanceProfiles, H3OnlyEnablesValidatedDeviceApiPairs) {
  const ProfileApi apis[] = {
      ProfileApi::Cuda,
      ProfileApi::Vulkan,
      ProfileApi::Metal,
      ProfileApi::Hip,
      ProfileApi::Unknown};
  const ProfileGpu gpus[] = {
      ProfileGpu::Rtx5090,
      ProfileGpu::Gb10,
      ProfileGpu::M3Ultra,
      ProfileGpu::StrixHalo,
      ProfileGpu::Unknown};
  for (const auto api : apis) {
    for (const auto gpu : gpus) {
      const bool rtx = gpu == ProfileGpu::Rtx5090 &&
                       (api == ProfileApi::Cuda || api == ProfileApi::Vulkan);
      const bool expected =
          rtx || (gpu == ProfileGpu::Gb10 && api == ProfileApi::Cuda) ||
          (gpu == ProfileGpu::M3Ultra && api == ProfileApi::Metal) ||
          (gpu == ProfileGpu::StrixHalo && api == ProfileApi::Hip);
      const auto profile = selectPerformanceProfile(
          {}, ProfileModel::MiniMaxH3FL2VAQ4, device(api, gpu));
      EXPECT_EQ(profile.flashAttention, expected);
      EXPECT_EQ(profile.h3LocalOps, rtx);
    }
  }
}

TEST(SdPerformanceProfiles, ExplicitFalseAndAliasesWin) {
  for (const auto* key : {"flash_attn", "fa"}) {
    SdCtxConfig config;
    applySdCtxHandlers(config, {{key, "false"}});
    const auto profile = selectPerformanceProfile(
        config,
        ProfileModel::MiniMaxH3FL2VAQ4,
        device(ProfileApi::Cuda, ProfileGpu::Rtx5090));
    EXPECT_FALSE(profile.flashAttention);
    EXPECT_FALSE(profile.h3LocalOps);
  }
}

TEST(SdPerformanceProfiles, H3GraphRequiresMemoryHeadroom) {
  auto gpu = device(ProfileApi::Cuda, ProfileGpu::Rtx5090);
  gpu.freeBytes = 28 * GIB;
  EXPECT_TRUE(selectPerformanceProfile({}, ProfileModel::MiniMaxH3FL2VAQ4, gpu)
                  .h3LocalOps);
  gpu.freeBytes -= 1;
  const auto profile =
      selectPerformanceProfile({}, ProfileModel::MiniMaxH3FL2VAQ4, gpu);
  EXPECT_FALSE(profile.h3LocalOps);
  EXPECT_TRUE(profile.flashAttention);
}

TEST(SdPerformanceProfiles, FluxRequiresBoundedWorkloadAndFreeMemory) {
  SdCtxConfig config;
  auto gpu = device(ProfileApi::Cuda, ProfileGpu::Rtx5090);
  const auto select = [&] {
    return selectPerformanceProfile(config, ProfileModel::Flux2Klein4BQ8, gpu);
  };
  EXPECT_TRUE(select().vaeGemm);
  EXPECT_TRUE(useVaeGemm(select(), 1024, 1024, 1, 16 * GIB));
  EXPECT_FALSE(useVaeGemm(select(), 1024, 1024, 1, 24 * GIB, true));
  EXPECT_FALSE(useVaeGemm(select(), 1024, 1024, 1, 16 * GIB - 1));
  EXPECT_FALSE(useVaeGemm(select(), 1024, 1024, 2, 24 * GIB));
  EXPECT_FALSE(useVaeGemm(select(), 2048, 512, 1, 24 * GIB));
  EXPECT_FALSE(useVaeGemm(select(), 768, 768, 1, 24 * GIB));
  EXPECT_TRUE(useVaeGemm(select(), 512, 512, 1, 16 * GIB));
  gpu = device(ProfileApi::Hip, ProfileGpu::StrixHalo);
  EXPECT_FALSE(select().vaeGemm);
  EXPECT_FALSE(useVaeGemm(select(), 1024, 1024, 1, 16 * GIB));
  EXPECT_FALSE(useVaeGemm(select(), 512, 512, 1, 16 * GIB));
  for (const auto api : {ProfileApi::Metal, ProfileApi::Vulkan}) {
    gpu.api = api;
    EXPECT_FALSE(select().vaeGemm);
  }
  gpu = device(ProfileApi::Cuda, ProfileGpu::Rtx5090);
  applySdCtxHandlers(config, {{"vae_conv_direct", "true"}});
  EXPECT_FALSE(select().vaeGemm);
}

TEST(SdPerformanceProfiles, H3GraphRequiresValidatedVideoShape) {
  const auto profile = selectPerformanceProfile(
      {},
      ProfileModel::MiniMaxH3FL2VAQ4,
      device(ProfileApi::Cuda, ProfileGpu::Rtx5090));
  EXPECT_TRUE(useH3LocalOps(profile, 960, 544, 124));
  EXPECT_FALSE(useH3LocalOps(profile, 512, 288, 39));
  EXPECT_FALSE(useH3LocalOps(profile, 1920, 544, 124));
  EXPECT_FALSE(useH3LocalOps(profile, 960, 1088, 124));
  EXPECT_FALSE(useH3LocalOps(profile, 960, 544, 141));
  EXPECT_FALSE(useH3LocalOps({}, 960, 544, 124));
}

TEST(SdPerformanceProfiles, LtxF16RetainsBaselineOutsideValidatedBudget) {
  SdCtxConfig config;
  auto gpu = device(ProfileApi::Metal, ProfileGpu::M3Ultra);
  const auto select = [&] {
    return selectPerformanceProfile(config, ProfileModel::Ltx23Q5, gpu);
  };
  EXPECT_FALSE(select().ltxF16);
  applySdCtxHandlers(
      config,
      {{"performance_max_width", "512"},
       {"performance_max_height", "320"},
       {"performance_max_frames", "97"}});
  EXPECT_TRUE(select().ltxF16);
  config.performanceMaxFrames += 1;
  EXPECT_FALSE(select().ltxF16);
  config.performanceMaxFrames -= 1;
  gpu.hostFreeBytes = 75 * GIB;
  EXPECT_FALSE(select().ltxF16);
  gpu.hostFreeBytes = 90 * GIB;
  applySdCtxHandlers(config, {{"tensor_type_rules", ""}});
  EXPECT_FALSE(select().ltxF16);
}

TEST(
    SdPerformanceProfiles,
    DeclaredVideoBoundsAreEnforcedWithoutChangingInputLimits) {
  SdCtxConfig config;
  EXPECT_ANY_THROW(
      applySdCtxHandlers(config, {{"performance_max_width", "512"}}));
  applySdCtxHandlers(
      config,
      {{"performance_max_width", "512"},
       {"performance_max_height", "320"},
       {"performance_max_frames", "97"}});
  EXPECT_NO_THROW(validatePerformanceWorkload(config, 512, 320, 97));
  EXPECT_ANY_THROW(validatePerformanceWorkload(config, 512, 320, 193));
  EXPECT_ANY_THROW(validatePerformanceWorkload(config, 1024, 320, 97));
  EXPECT_ANY_THROW(validatePerformanceWorkload(config, 512, 640, 97));
  EXPECT_ANY_THROW(
      applySdCtxHandlers(config, {{"performance_max_frames", "auto"}}));
}

TEST(SdPerformanceProfiles, LtxKeepsExistingTemporalDefaultAndOverrides) {
  SdCtxConfig config;
  const auto gpu = device(ProfileApi::Cuda, ProfileGpu::Rtx5090);
  EXPECT_FALSE(
      selectPerformanceProfile(config, ProfileModel::Ltx23Q5, gpu).ltxF16);
  SdVidGenConfig request;
  EXPECT_FALSE(request.vaeTemporalTiling);
  applySdVidGenHandlers(request, {{"temporal_tiling", picojson::value(true)}});
  EXPECT_TRUE(request.vaeTemporalTiling);
  applySdVidGenHandlers(request, {{"temporal_tiling", picojson::value(false)}});
  EXPECT_FALSE(request.vaeTemporalTiling);
  EXPECT_ANY_THROW(applySdCtxHandlers(
      config, {{"performance_profile", "allow-small-changes"}}));
}

TEST(SdPerformanceProfiles, OptOutAndUnknownModelsKeepDefaults) {
  SdCtxConfig config;
  const auto gpu = device(ProfileApi::Cuda, ProfileGpu::Rtx5090);
  EXPECT_FALSE(selectPerformanceProfile(config, ProfileModel::Unknown, gpu)
                   .flashAttention);
  applySdCtxHandlers(config, {{"performance_profile", "off"}});
  EXPECT_FALSE(
      selectPerformanceProfile(config, ProfileModel::MiniMaxH3FL2VAQ4, gpu)
          .flashAttention);
  EXPECT_ANY_THROW(
      applySdCtxHandlers(config, {{"performance_profile", "fast"}}));
}

TEST(SdPerformanceProfiles, ExplicitGraphAndMemoryPoliciesKeepDefaults) {
  const auto gpu = device(ProfileApi::Cuda, ProfileGpu::Rtx5090);
  for (const auto& option :
       {std::pair<const char*, const char*>{"performance_profile", "off"},
        {"max_vram", "8GB"},
        {"stream_layers", "true"},
        {"diffusion_fa", "false"},
        {"vae_auto_cpu_fallback", "true"},
        {"tensor_type_rules", ".*=f16"}}) {
    SdCtxConfig config;
    applySdCtxHandlers(config, {{option.first, option.second}});
    for (const auto model :
         {ProfileModel::Flux2Klein4BQ8,
          ProfileModel::MiniMaxH3FL2VAQ4,
          ProfileModel::Ltx23Q5}) {
      const auto profile = selectPerformanceProfile(config, model, gpu);
      EXPECT_FALSE(profile.flashAttention);
      EXPECT_FALSE(profile.h3LocalOps);
      EXPECT_FALSE(profile.vaeGemm);
      EXPECT_FALSE(profile.ltxF16);
    }
  }
  for (const auto* value : {"true", "false"}) {
    SdCtxConfig config;
    applySdCtxHandlers(config, {{"vae_conv_direct", value}});
    EXPECT_FALSE(
        selectPerformanceProfile(config, ProfileModel::Flux2Klein4BQ8, gpu)
            .vaeGemm);
  }
}

TEST(SdPerformanceProfiles, VendorNameDoesNotSubstituteForApiOrGpu) {
  const auto unknown = classifyProfileDevice("CUDA", "NVIDIA RTX 4090", 0, 0);
  EXPECT_EQ(unknown.gpu, ProfileGpu::Unknown);
  const auto vulkan =
      classifyProfileDevice("Vulkan", "NVIDIA GeForce RTX 5090", 0, 0);
  EXPECT_EQ(vulkan.api, ProfileApi::Vulkan);
  EXPECT_EQ(vulkan.gpu, ProfileGpu::Rtx5090);
  EXPECT_EQ(
      classifyProfileDevice("ROCm", "AMD Radeon 8060S Graphics", 0, 0).api,
      ProfileApi::Hip);
  EXPECT_EQ(
      classifyProfileDevice("ROCm", "Radeon 8060S Graphics", 0, 0).gpu,
      ProfileGpu::StrixHalo);
}

namespace {
void writeGgufDescription(
    const std::filesystem::path& path, int count, uint64_t payload,
    ProfileModel model = ProfileModel::Unknown, bool rewriteHeader = false) {
  const std::unique_ptr<ggml_context, decltype(&ggml_free)> tensors(
      ggml_init({8 * 1024 * 1024, nullptr, true}), ggml_free);
  const std::unique_ptr<gguf_context, decltype(&gguf_free)> metadata(
      gguf_init_empty(), gguf_free);
  ASSERT_TRUE(tensors);
  ASSERT_TRUE(metadata);
  if (rewriteHeader)
    gguf_set_val_str(metadata.get(), "tokenizer.ggml.model", "none");
  uint64_t offset = 0;
  for (int i = 0; i < count; ++i) {
    const bool last = i == count - 1;
    auto* tensor = ggml_new_tensor_1d(
        tensors.get(),
        last                                    ? GGML_TYPE_I8
        : model == ProfileModel::Flux2Klein4BQ8 ? GGML_TYPE_Q8_0
                                                : GGML_TYPE_Q6_K,
        last ? static_cast<int64_t>(payload - offset) : 256);
    std::string name = "fixture." + std::to_string(i);
    if (model == ProfileModel::MiniMaxH3FL2VAQ4 && i < 2)
      name = i == 0 ? "model.diffusion_model.audio_patch_proj.weight"
                    : "model.diffusion_model.video_patch_proj.weight";
    else if (i == 0 && model != ProfileModel::Unknown)
      name = model == ProfileModel::Flux2Klein4BQ8
                 ? "double_blocks.0.img_attn.qkv.weight"
                 : "transformer_blocks.0.attn1.to_gate_logits.weight";
    ggml_set_name(tensor, name.c_str());
    gguf_add_tensor(metadata.get(), tensor);
    offset += (ggml_nbytes(tensor) + 31) / 32 * 32;
  }
  ASSERT_EQ(offset, payload);
  ASSERT_TRUE(gguf_write_to_file(metadata.get(), path.string().c_str(), true));
}

void writeSafetensorsDescription(
    const std::filesystem::path& path, uint64_t bytes) {
  const uint64_t length = 128;
  const auto dataBytes = std::to_string(bytes - sizeof(length) - length);
  std::string header = "{\"weight\":{\"dtype\":\"I8\",\"shape\":[" + dataBytes +
                       "],\"data_offsets\":[0," + dataBytes + "]}}";
  header.resize(length, ' ');
  std::ofstream file(path, std::ios::binary);
  file.write(reinterpret_cast<const char*>(&length), sizeof(length));
  file.write(header.data(), header.size());
  ASSERT_TRUE(file.good());
}
} // namespace

TEST(
    SdPerformanceProfiles,
    MetadataOnlyFitRequiresMeasuredLayoutsAndCompanions) {
  const auto dir = std::filesystem::temp_directory_path() /
                   "qvac-performance-fit-descriptions";
  std::filesystem::create_directories(dir);
  struct Cleanup {
    std::filesystem::path path;
    ~Cleanup() { std::filesystem::remove_all(path); }
  } cleanup{dir};
  const auto path = dir / "model.gguf";
  for (const auto model :
       {ProfileModel::Flux2Klein4BQ8,
        ProfileModel::MiniMaxH3FL2VAQ4,
        ProfileModel::Ltx23Q5}) {
    const bool flux = model == ProfileModel::Flux2Klein4BQ8;
    const bool h3 = model == ProfileModel::MiniMaxH3FL2VAQ4;
    const int count = flux ? 149 : h3 ? 532 : 4444;
    const uint64_t payload = flux ? 4300634112ULL
                             : h3 ? 11420630112ULL
                                  : 19388047360ULL;
    const uint64_t encoder = flux ? 2491323904ULL
                             : h3 ? 18217999840ULL
                                  : 7425677184ULL;
    writeGgufDescription(path, count, payload, model);
    SdCtxConfig config;
    config.diffusionModelPath = path.string();
    config.llmPath = (dir / "encoder.gguf").string();
    config.vaePath = (dir / "vae.safetensors").string();
    config.audioVaePath = (dir / "audio.safetensors").string();
    config.embeddingsConnectorsPath = (dir / "connectors.safetensors").string();
    config.performanceMaxWidth = 512;
    config.performanceMaxHeight = 320;
    config.performanceMaxFrames = 97;
    writeGgufDescription(config.llmPath, 1, encoder);
    writeSafetensorsDescription(
        config.vaePath,
        flux ? 168120878ULL
        : h3 ? 5207808496ULL
             : 1452256522ULL);
    writeSafetensorsDescription(
        config.audioVaePath, h3 ? 605254808ULL : 364853140ULL);
    writeSafetensorsDescription(config.embeddingsConnectorsPath, 2312144712ULL);
    const auto gpu = h3 || flux
                         ? device(ProfileApi::Cuda, ProfileGpu::Rtx5090)
                         : device(ProfileApi::Metal, ProfileGpu::M3Ultra);
    EXPECT_EQ(inspectProfileModel(config), ProfileModel::Unknown);
    EXPECT_EQ(inspectProfileModel(config, true), model);
    const auto profile = selectPerformanceProfile(
        config, inspectProfileModel(config, true), gpu);
    EXPECT_EQ(profile.flashAttention, h3);
    EXPECT_EQ(profile.vaeGemm, flux);
    EXPECT_EQ(profile.ltxF16, !h3 && !flux);

    writeGgufDescription(path, count, payload, model, true);
    writeGgufDescription(
        config.llmPath, 1, encoder, ProfileModel::Unknown, true);
    EXPECT_EQ(inspectProfileModel(config, true), model)
        << "rewritten registry headers";
    writeGgufDescription(config.llmPath, 1, encoder + 32);
    EXPECT_EQ(inspectProfileModel(config, true), ProfileModel::Unknown)
        << "different encoder layout";
    writeGgufDescription(config.llmPath, 1, encoder);
    std::ofstream(config.vaePath, std::ios::binary) << "not a measured VAE";
    EXPECT_EQ(inspectProfileModel(config, true), ProfileModel::Unknown)
        << "different companion";
    writeSafetensorsDescription(
        config.vaePath,
        flux ? 168120878ULL
        : h3 ? 5207808496ULL
             : 1452256522ULL);
    writeGgufDescription(path, count, payload + 32, model);
    EXPECT_EQ(inspectProfileModel(config, true), ProfileModel::Unknown)
        << "different diffusion layout";
    writeGgufDescription(path, count, payload, model);
    std::ofstream(path, std::ios::binary | std::ios::app).put('\0');
    EXPECT_EQ(inspectProfileModel(config, true), ProfileModel::Unknown)
        << "partial weights are not metadata only";

    // A small complete checkpoint with matching marker names is still
    // unmeasured.
    const uint64_t smallPayload = count * 512;
    writeGgufDescription(path, count, smallPayload, model);
    std::ofstream full(path, std::ios::binary | std::ios::app);
    const std::string data(static_cast<size_t>(smallPayload), '\0');
    full.write(data.data(), data.size());
    full.close();
    EXPECT_EQ(inspectProfileModel(config), ProfileModel::Unknown);
    EXPECT_EQ(inspectProfileModel(config, true), ProfileModel::Unknown);
    writeGgufDescription(path, count, payload, model);
    config.performanceProfile = "off";
    EXPECT_EQ(inspectProfileModel(config, true), ProfileModel::Unknown);
  }
}
