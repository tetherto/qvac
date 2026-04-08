#include <string>
#include <unordered_map>

#include <gtest/gtest.h>

#include "handlers/SdCtxHandlers.hpp"
#include "utils/LoggingMacros.hpp"

using namespace qvac_lib_inference_addon_sd;
using namespace qvac_errors;

namespace {

static SdCtxConfig applyOne(const std::string& key, const std::string& value) {
  SdCtxConfig cfg;
  applySdCtxHandlers(cfg, std::unordered_map<std::string, std::string>{{key, value}});
  return cfg;
}

} // namespace

TEST(SdCtxHandlers_Prediction, SupportedValuesMapAndUnknownThrows) {
  EXPECT_EQ(applyOne("prediction", "").prediction, PREDICTION_COUNT);
  EXPECT_EQ(applyOne("prediction", "auto").prediction, PREDICTION_COUNT);
  EXPECT_EQ(applyOne("prediction", "eps").prediction, EPS_PRED);
  EXPECT_EQ(applyOne("prediction", "v").prediction, V_PRED);
  EXPECT_EQ(applyOne("prediction", "edm_v").prediction, EDM_V_PRED);
  EXPECT_EQ(applyOne("prediction", "flow").prediction, FLOW_PRED);
  EXPECT_EQ(applyOne("prediction", "flux_flow").prediction, FLUX_FLOW_PRED);
  EXPECT_EQ(applyOne("prediction", "flux2_flow").prediction, FLUX2_FLOW_PRED);

  SdCtxConfig cfg;
  EXPECT_THROW(
      applySdCtxHandlers(
          cfg,
          std::unordered_map<std::string, std::string>{{"prediction", "bogus"}}),
      StatusError);
}

TEST(SdCtxHandlers_Type, SupportedValuesMapAndUnknownThrows) {
  EXPECT_EQ(applyOne("type", "").wtype, SD_TYPE_COUNT);
  EXPECT_EQ(applyOne("type", "auto").wtype, SD_TYPE_COUNT);
  EXPECT_EQ(applyOne("type", "f32").wtype, SD_TYPE_F32);
  EXPECT_EQ(applyOne("type", "f16").wtype, SD_TYPE_F16);
  EXPECT_EQ(applyOne("type", "bf16").wtype, SD_TYPE_BF16);
  EXPECT_EQ(applyOne("type", "q4_0").wtype, SD_TYPE_Q4_0);
  EXPECT_EQ(applyOne("type", "q4_1").wtype, SD_TYPE_Q4_1);
  EXPECT_EQ(applyOne("type", "q4_k").wtype, SD_TYPE_Q4_K);
  EXPECT_EQ(applyOne("type", "q5_0").wtype, SD_TYPE_Q5_0);
  EXPECT_EQ(applyOne("type", "q5_1").wtype, SD_TYPE_Q5_1);
  EXPECT_EQ(applyOne("type", "q5_k").wtype, SD_TYPE_Q5_K);
  EXPECT_EQ(applyOne("type", "q6_k").wtype, SD_TYPE_Q6_K);
  EXPECT_EQ(applyOne("type", "q8_0").wtype, SD_TYPE_Q8_0);
  EXPECT_EQ(applyOne("type", "q2_k").wtype, SD_TYPE_Q2_K);
  EXPECT_EQ(applyOne("type", "q3_k").wtype, SD_TYPE_Q3_K);

  SdCtxConfig cfg;
  EXPECT_THROW(
      applySdCtxHandlers(
          cfg,
          std::unordered_map<std::string, std::string>{{"type", "bogus"}}),
      StatusError);
}

TEST(SdCtxHandlers_FlashAttn, ShortAndLongKeysMapTrueFalseAndInvalidThrows) {
  EXPECT_TRUE(applyOne("fa", "true").flashAttn);
  EXPECT_TRUE(applyOne("flash_attn", "1").flashAttn);
  EXPECT_FALSE(applyOne("fa", "false").flashAttn);

  SdCtxConfig cfg;
  EXPECT_THROW(
      applySdCtxHandlers(
          cfg,
          std::unordered_map<std::string, std::string>{{"fa", "maybe"}}),
      StatusError);
}

TEST(SdCtxHandlers_Rng, RngAndSamplerRngSupportedValuesAndUnknownThrow) {
  EXPECT_EQ(applyOne("rng", "cpu").rngType, CPU_RNG);
  EXPECT_EQ(applyOne("rng", "cuda").rngType, CUDA_RNG);
  EXPECT_EQ(applyOne("rng", "std_default").rngType, STD_DEFAULT_RNG);

  EXPECT_EQ(applyOne("sampler_rng", "cpu").samplerRngType, CPU_RNG);
  EXPECT_EQ(applyOne("sampler_rng", "cuda").samplerRngType, CUDA_RNG);
  EXPECT_EQ(
      applyOne("sampler_rng", "std_default").samplerRngType,
      STD_DEFAULT_RNG);

  SdCtxConfig cfgA;
  EXPECT_THROW(
      applySdCtxHandlers(
          cfgA,
          std::unordered_map<std::string, std::string>{{"rng", "bogus"}}),
      StatusError);

  SdCtxConfig cfgB;
  EXPECT_THROW(
      applySdCtxHandlers(
          cfgB,
          std::unordered_map<std::string, std::string>{{"sampler_rng", "bogus"}}),
      StatusError);
}

TEST(SdCtxHandlers_LoraApplyMode, SupportedValuesAndUnknownThrows) {
  EXPECT_EQ(
      applyOne("lora_apply_mode", "auto").loraApplyMode,
      LORA_APPLY_AUTO);
  EXPECT_EQ(
      applyOne("lora_apply_mode", "immediately").loraApplyMode,
      LORA_APPLY_IMMEDIATELY);
  EXPECT_EQ(
      applyOne("lora_apply_mode", "at_runtime").loraApplyMode,
      LORA_APPLY_AT_RUNTIME);

  SdCtxConfig cfg;
  EXPECT_THROW(
      applySdCtxHandlers(
          cfg,
          std::unordered_map<std::string, std::string>{{"lora_apply_mode", "bogus"}}),
      StatusError);
}

TEST(SdCtxHandlers_Threads, ValidIntegerAndInvalidThrows) {
  EXPECT_EQ(applyOne("threads", "8").nThreads, 8);

  SdCtxConfig cfg;
  EXPECT_THROW(
      applySdCtxHandlers(
          cfg,
          std::unordered_map<std::string, std::string>{{"threads", "abc"}}),
      StatusError);
}

TEST(SdCtxHandlers_MemoryFlags, BoolKeysMapAndInvalidThrow) {
  EXPECT_TRUE(applyOne("mmap", "true").mmap);
  EXPECT_TRUE(applyOne("offload_to_cpu", "1").offloadToCpu);
  EXPECT_FALSE(applyOne("clip_on_cpu", "false").keepClipOnCpu);
  EXPECT_TRUE(applyOne("vae_on_cpu", "true").keepVaeOnCpu);

  SdCtxConfig cfg;
  EXPECT_THROW(
      applySdCtxHandlers(
          cfg,
          std::unordered_map<std::string, std::string>{{"mmap", "maybe"}}),
      StatusError);
}

TEST(
    SdCtxHandlers_ComputeAndCompatFlags,
    DiffusionFaConvAndSdxlFlagsMapAndInvalidThrow) {
  EXPECT_TRUE(applyOne("diffusion_fa", "true").diffusionFlashAttn);
  EXPECT_TRUE(
      applyOne("diffusion_conv_direct", "1").diffusionConvDirect);
  EXPECT_FALSE(applyOne("vae_conv_direct", "0").vaeConvDirect);
  EXPECT_TRUE(
      applyOne("force_sdxl_vae_conv_scale", "true").forceSDXLVaeConvScale);

  SdCtxConfig cfg;
  EXPECT_THROW(
      applySdCtxHandlers(
          cfg,
          std::unordered_map<std::string, std::string>{
              {"diffusion_conv_direct", "bogus"}}),
      StatusError);
}

TEST(
    SdCtxHandlers_PassthroughAndFloat,
    DeviceTensorRulesBackendsDirAndFlowShift) {
  EXPECT_EQ(applyOne("device", "cpu").device, "cpu");
  EXPECT_EQ(
      applyOne("tensor_type_rules", "^vae.=f16").tensorTypeRules,
      "^vae.=f16");
  EXPECT_EQ(applyOne("backendsDir", "/tmp/backends").backendsDir, "/tmp/backends");
  EXPECT_FLOAT_EQ(applyOne("flow_shift", "1.25").flowShift, 1.25f);

  SdCtxConfig cfg;
  EXPECT_THROW(
      applySdCtxHandlers(
          cfg,
          std::unordered_map<std::string, std::string>{{"flow_shift", "bogus"}}),
      StatusError);
}

TEST(SdCtxHandlers_Verbosity, SupportedLevelsSetGlobalVerbosity) {
  logging::g_verbosityLevel =
      qvac_lib_inference_addon_cpp::logger::Priority::ERROR;

  SdCtxConfig cfg0;
  applySdCtxHandlers(
      cfg0,
      std::unordered_map<std::string, std::string>{{"verbosity", "0"}});
  EXPECT_EQ(
      logging::g_verbosityLevel,
      qvac_lib_inference_addon_cpp::logger::Priority::ERROR);

  SdCtxConfig cfg1;
  applySdCtxHandlers(
      cfg1,
      std::unordered_map<std::string, std::string>{{"verbosity", "1"}});
  EXPECT_EQ(
      logging::g_verbosityLevel,
      qvac_lib_inference_addon_cpp::logger::Priority::WARNING);

  SdCtxConfig cfg2;
  applySdCtxHandlers(
      cfg2,
      std::unordered_map<std::string, std::string>{{"verbosity", "2"}});
  EXPECT_EQ(
      logging::g_verbosityLevel,
      qvac_lib_inference_addon_cpp::logger::Priority::INFO);

  SdCtxConfig cfg3;
  applySdCtxHandlers(
      cfg3,
      std::unordered_map<std::string, std::string>{{"verbosity", "3"}});
  EXPECT_EQ(
      logging::g_verbosityLevel,
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG);
}

TEST(SdCtxHandlers_Verbosity, InvalidValueFallsBackToError) {
  logging::g_verbosityLevel =
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG;

  SdCtxConfig cfg;
  applySdCtxHandlers(
      cfg,
      std::unordered_map<std::string, std::string>{{"verbosity", "bogus"}});

  EXPECT_EQ(
      logging::g_verbosityLevel,
      qvac_lib_inference_addon_cpp::logger::Priority::ERROR);
}

TEST(SdCtxHandlers_UnknownKeys, AreIgnored) {
  SdCtxConfig cfg;
  EXPECT_NO_THROW(
      applySdCtxHandlers(
          cfg,
          std::unordered_map<std::string, std::string>{{"unknown_key", "value"}}));
  EXPECT_EQ(cfg.device, "gpu");
  EXPECT_EQ(cfg.nThreads, -1);
}
