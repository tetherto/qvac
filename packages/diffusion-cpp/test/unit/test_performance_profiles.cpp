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

TEST(SdPerformanceProfiles, FluxRequiresBoundedWorkloadAndFreeMemory) {
  SdCtxConfig config;
  auto gpu = device(ProfileApi::Cuda, ProfileGpu::Rtx5090);
  const auto select = [&] {
    return selectPerformanceProfile(config, ProfileModel::Flux2Klein4BQ8, gpu);
  };
  EXPECT_TRUE(select().vaeGemm);
  EXPECT_TRUE(useVaeGemm(select(), 1024, 1024, 1, 16 * GIB));
  EXPECT_FALSE(useVaeGemm(select(), 1024, 1024, 1, 16 * GIB - 1));
  EXPECT_FALSE(useVaeGemm(select(), 1024, 1024, 2, 24 * GIB));
  EXPECT_FALSE(useVaeGemm(select(), 2048, 512, 1, 24 * GIB));
  EXPECT_FALSE(useVaeGemm(select(), 768, 768, 1, 24 * GIB));
  EXPECT_TRUE(useVaeGemm(select(), 512, 512, 1, 16 * GIB));
  gpu = device(ProfileApi::Hip, ProfileGpu::StrixHalo);
  EXPECT_TRUE(useVaeGemm(select(), 1024, 1024, 1, 16 * GIB));
  EXPECT_FALSE(useVaeGemm(select(), 512, 512, 1, 16 * GIB));
  for (const auto api : {ProfileApi::Metal, ProfileApi::Vulkan}) {
    gpu.api = api;
    EXPECT_FALSE(select().vaeGemm);
  }
  gpu = device(ProfileApi::Cuda, ProfileGpu::Rtx5090);
  applySdCtxHandlers(config, {{"vae_conv_direct", "true"}});
  EXPECT_FALSE(select().vaeGemm);
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
