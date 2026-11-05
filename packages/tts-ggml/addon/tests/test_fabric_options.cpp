#include <filesystem>
#include <fstream>
#include <memory>
#include <random>
#include <string>

#include <gguf.h>
#include <gtest/gtest.h>
#include <tts-cpp/moss/engine.h>
#include <tts-cpp/parler/engine.h>
#include <tts-cpp/supertonic/engine.h>

#include "model-interface/BackendUtils.hpp"
#include "model-interface/WebGpuPolicy.hpp"
#include "model-interface/cosyvoice/CosyvoiceModel.hpp"
#include "model-interface/cosyvoice/ForcedSpeechTokens.hpp"
#include "model-interface/moss/MossModel.hpp"
#include "model-interface/parler/ParlerModel.hpp"
#include "model-interface/supertonic/SupertonicEngineOptions.hpp"

namespace {

class MetadataFile {
public:
  explicit MetadataFile(const char* architecture, int vocabularyRows = 0)
      : path_(
            std::filesystem::temp_directory_path() /
            ("tts-fabric-options-" + std::to_string(std::random_device{}()) +
             ".gguf")) {
    std::unique_ptr<gguf_context, decltype(&gguf_free)> context(
        gguf_init_empty(), gguf_free);
    gguf_set_val_str(context.get(), "general.architecture", architecture);
    std::unique_ptr<ggml_context, decltype(&ggml_free)> tensors(
        ggml_init({ggml_tensor_overhead(), nullptr, true}), ggml_free);
    if (vocabularyRows > 0) {
      auto* embedding =
          ggml_new_tensor_2d(tensors.get(), GGML_TYPE_F32, 1, vocabularyRows);
      ggml_set_name(embedding, "flow/input_embedding/weight");
      gguf_add_tensor(context.get(), embedding);
    }
    gguf_write_to_file(context.get(), path_.string().c_str(), true);
  }
  ~MetadataFile() {
    std::error_code ignored;
    std::filesystem::remove(path_, ignored);
  }
  std::string path() const { return path_.string(); }

private:
  std::filesystem::path path_;
};

TEST(FabricOptions, WebGpuKeepsItsRuntimeIdentity) {
  using namespace qvac::ttsggml;
  EXPECT_EQ(backendIdFromName("WebGPU0"), 5);
  EXPECT_EQ(backendIdFromName("Hexagon"), 99);
  EXPECT_EQ(
      backendDeviceCode(tts_cpp::BackendDevice::CoreML), kBackendDeviceCoreML);
  EXPECT_EQ(backendDeviceFromName("unknown"), 99);
}

TEST(
    FabricOptions,
    ForcedSpeechIdsUseTheFlowModelVocabularyWithoutReadingWeights) {
  const MetadataFile flow("cosyvoice", 3);
  tts_cpp::cosyvoice::EngineOptions options;
  options.flow_gguf_path = flow.path();
  options.force_speech_tokens = {0, 2};
  EXPECT_NO_THROW(
      qvac::ttsggml::cosyvoice::validateForcedSpeechTokens(options));
  options.force_speech_tokens = {-1};
  EXPECT_ANY_THROW(
      qvac::ttsggml::cosyvoice::validateForcedSpeechTokens(options));
  options.force_speech_tokens = {3};
  EXPECT_ANY_THROW(
      qvac::ttsggml::cosyvoice::validateForcedSpeechTokens(options));
  options.force_speech_tokens = {};
  options.flow_gguf_path = "missing.gguf";
  EXPECT_NO_THROW(
      qvac::ttsggml::cosyvoice::validateForcedSpeechTokens(options));
}

TEST(FabricOptions, SupertonicWebGpuChecksModelMetadataRatherThanFilename) {
  const MetadataFile versionThree("supertonic3");
  const MetadataFile versionTwo("supertonic2");
  EXPECT_NO_THROW(
      qvac::ttsggml::requireSupertonicWebGpuSupport(
          "webgpu", versionThree.path()));
  EXPECT_ANY_THROW(
      qvac::ttsggml::requireSupertonicWebGpuSupport(
          "WebGPU0", versionTwo.path()));
  EXPECT_NO_THROW(
      qvac::ttsggml::requireSupertonicWebGpuSupport("cpu", "missing.gguf"));
}

TEST(FabricOptions, MossPreservesNativeDefaultsAndMapsIndependentSamplers) {
  qvac::ttsggml::moss::MossConfig config;
  const tts_cpp::moss::EngineOptions defaults;
  auto options = qvac::ttsggml::moss::MossModel::toEngineOptions(config);
  EXPECT_EQ(options.max_new_tokens, defaults.max_new_tokens);
  EXPECT_EQ(options.context, defaults.context);
  EXPECT_EQ(options.text_temperature, defaults.text_temperature);
  EXPECT_EQ(options.audio_temperature, defaults.audio_temperature);
  config.backend = "Vulkan0";
  config.nCtx = 8192;
  config.maxNewTokens = 4096;
  config.textTemperature = 0.0F;
  config.textTopK = 0;
  config.textTopP = 0.9F;
  config.audioTemperature = 1.2F;
  config.audioTopK = 25;
  config.audioTopP = 0.8F;
  config.audioRepetitionPenalty = 1.1F;
  options = qvac::ttsggml::moss::MossModel::toEngineOptions(config);
  EXPECT_EQ(options.backend, "Vulkan0");
  EXPECT_EQ(options.context, 8192);
  EXPECT_EQ(options.max_new_tokens, 4096);
  EXPECT_EQ(options.text_temperature, 0.0F);
  EXPECT_EQ(options.text_top_k, 0);
  EXPECT_EQ(options.text_top_p, 0.9F);
  EXPECT_EQ(options.audio_temperature, 1.2F);
  EXPECT_EQ(options.audio_top_k, 25);
  EXPECT_EQ(options.audio_top_p, 0.8F);
  EXPECT_EQ(options.audio_repetition_penalty, 1.1F);
}

TEST(FabricOptions, MossDurationValidationUsesTheConfiguredGenerationBudget) {
  const MetadataFile stub("moss");
  qvac::ttsggml::moss::MossConfig config;
  config.backbonePath = stub.path();
  config.codecDecoderPath = stub.path();
  config.durationTokens = 3000;
  EXPECT_ANY_THROW(qvac::ttsggml::moss::MossModel::validateConfig(config));
  config.maxNewTokens = 4096;
  EXPECT_NO_THROW(qvac::ttsggml::moss::MossModel::validateConfig(config));
  config.maxNewTokens = 0;
  EXPECT_ANY_THROW(qvac::ttsggml::moss::MossModel::validateConfig(config));
}

TEST(FabricOptions, ParlerCanOverrideStrictEnvironmentPolicyWithFalse) {
  qvac::ttsggml::parler::ParlerConfig config;
  auto options = qvac::ttsggml::parler::ParlerModel::toEngineOptions(config);
  EXPECT_FALSE(options.coreml_strict.has_value());
  config.backend = "WebGPU0";
  config.coremlDecoder = true;
  config.coremlComputeUnits = "cpu_and_ane";
  config.coremlStrict = false;
  options = qvac::ttsggml::parler::ParlerModel::toEngineOptions(config);
  EXPECT_EQ(options.backend, "WebGPU0");
  EXPECT_TRUE(options.coreml_decoder);
  EXPECT_EQ(options.coreml_compute_units, "cpu_and_ane");
  ASSERT_TRUE(options.coreml_strict.has_value());
  EXPECT_FALSE(*options.coreml_strict);
}

TEST(
    FabricOptions,
    SupertonicMapsPrecisionVoicesAndExplicitEnvironmentOverrides) {
  qvac::ttsggml::supertonic::SupertonicConfig config;
  config.precision = "q8_0";
  config.f16Attn = 0;
  config.f16Weights = -1;
  config.kvAttnType = 3;
  config.f16WeightsDenyList = {"decoder.weight"};
  config.voiceStyleTtl = {1.0F, 2.0F};
  config.voiceStyleDp = {3.0F, 4.0F};
  config.vulkanEnvOverrides = {{"GGML_VK_PIPELINE_CACHE_DIR", "/explicit"}};
  config.vulkanCacheDir = "/convenience";
  config.useGpu = true;
  const auto options =
      qvac::ttsggml::supertonic::detail::engineOptionsForTests(config);
  EXPECT_EQ(options.precision, tts_cpp::supertonic::Precision::Q8_0);
  EXPECT_EQ(options.f16_attn, 0);
  EXPECT_EQ(options.f16_weights, -1);
  EXPECT_EQ(options.kv_attn_type, 3);
  EXPECT_EQ(options.f16_weights_deny_list, config.f16WeightsDenyList);
  EXPECT_EQ(options.voice_style_ttl, config.voiceStyleTtl);
  EXPECT_EQ(options.voice_style_dp, config.voiceStyleDp);
  EXPECT_EQ(
      options.vulkan_env_overrides.at("GGML_VK_PIPELINE_CACHE_DIR"),
      "/explicit");
}

TEST(FabricOptions, CosyVoicePreservesGreedyFalseAndForcedTrajectoryZeros) {
  qvac::ttsggml::cosyvoice::CosyvoiceConfig config;
  config.backend = "Vulkan0";
  config.greedy = false;
  config.forceSpeechTokens = {0, 2, 4};
  const auto options = qvac::ttsggml::cosyvoice::toEngineOptions(config);
  EXPECT_EQ(options.backend, "Vulkan0");
  EXPECT_FALSE(options.greedy);
  EXPECT_EQ(options.force_speech_tokens, config.forceSpeechTokens);
}

} // namespace
