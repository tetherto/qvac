#include <functional>
#include <string>

#include <gtest/gtest.h>
#include <llama-cpp.h>

#include "model-interface/ModelMetadata.hpp"
#include "test_common.hpp"

// ---- Common types ----

using MetaChecker = std::function<void(const ModelMetaData&)>;

// ---- Test fixture ----

class ModelMetadataTest : public ::testing::Test {
protected:
  void SetUp() override {
    using MP = test_common::TestModelPath;

    normalModel_ =
        MP("Llama-3.2-1B-Instruct-Q4_0.gguf", nullptr, MP::OnMissing::Fail, "");

    bitnetModel_ =
        MP("bitnet_b1_58-large-TQ2_0.gguf",
           "BITNET_MODEL_PATH",
           MP::OnMissing::Skip,
           "https://huggingface.co/gianni-cor/bitnet_b1_58-large-TQ2_0");

    qwen3Model_ =
        MP("Qwen3-0.6B-Q8_0.gguf",
           "QWEN3_MODEL_PATH",
           MP::OnMissing::Skip,
           "https://huggingface.co/Qwen/Qwen3-0.6B-GGUF");

    // Metadata is read from the first shard, as for a single GGUF.
    // https://huggingface.co/jmb95/Qwen3-0.6B-UD-IQ1_S-sharded
    normalModelSharded_ =
        MP("Qwen3-0.6B-UD-IQ1_S-00001-of-00003.gguf",
           "SHARDED_MODEL_FIRST_SHARD_PATH",
           MP::OnMissing::Skip,
           "https://huggingface.co/jmb95/Qwen3-0.6B-UD-IQ-1_S-sharded");

    // https://huggingface.co/jmb95/bitnet_b1_58-large-TQ2_0-sharded
    bitnetModelSharded_ =
        MP("bitnet_b1_58-large-TQ2_0-00001-of-00008.gguf",
           nullptr,
           MP::OnMissing::Skip,
           "https://huggingface.co/jmb95/bitnet_b1_58-large-TQ2_0-sharded");
  }

  test_common::TestModelPath normalModel_;
  test_common::TestModelPath bitnetModel_;
  test_common::TestModelPath qwen3Model_;
  test_common::TestModelPath normalModelSharded_;
  test_common::TestModelPath bitnetModelSharded_;

  // ---- Parse-and-check helpers ----
  //
  // Each helper drives one parse strategy and calls check(meta) at the end.
  // Use ASSERT_NO_FATAL_FAILURE() at the call site if early exit on fatal
  // assertion failure is needed.

  void parseDiskSingleFile(const std::string& path, MetaChecker check) {
    ModelMetaData meta;
    meta.parse(path, "Test");
    check(meta);
  }

  void parseDiskShards(const std::string& path, MetaChecker check) {
    parseDiskSingleFile(path, check);
  }
};

// ---- Disk single file ----

TEST_F(
    ModelMetadataTest, DiskSingleFile_NormalModel_HasOneBitQuantizationFalse) {
  REQUIRE_MODEL(normalModel_);
  parseDiskSingleFile(normalModel_.path, [](const ModelMetaData& meta) {
    EXPECT_FALSE(meta.hasOneBitQuantization());
  });
}

TEST_F(
    ModelMetadataTest, DiskSingleFile_BitnetModel_HasOneBitQuantizationTrue) {
  REQUIRE_MODEL(bitnetModel_);
  parseDiskSingleFile(bitnetModel_.path, [](const ModelMetaData& meta) {
    EXPECT_TRUE(meta.hasOneBitQuantization());
  });
}

// ---- Disk shards ----

TEST_F(ModelMetadataTest, DiskShards_NormalModel_HasOneBitQuantizationFalse) {
  REQUIRE_MODEL(normalModelSharded_);
  parseDiskShards(normalModelSharded_.path, [](const ModelMetaData& meta) {
    EXPECT_FALSE(meta.hasOneBitQuantization());
  });
}

TEST_F(ModelMetadataTest, DiskShards_BitnetModel_HasOneBitQuantizationTrue) {
  REQUIRE_MODEL(bitnetModelSharded_);
  parseDiskShards(bitnetModelSharded_.path, [](const ModelMetaData& meta) {
    EXPECT_TRUE(meta.hasOneBitQuantization());
  });
}

// ---- tryGetString: architecture detection via "general.architecture" ----
//
// The "general.architecture" GGUF string key is "bitnet" for BitNet models
// and a different value (e.g. "llama", "qwen3") for all others.

TEST_F(ModelMetadataTest, DiskSingleFile_NormalModel_ArchitectureIsNotBitnet) {
  REQUIRE_MODEL(normalModel_);
  parseDiskSingleFile(normalModel_.path, [](const ModelMetaData& meta) {
    auto arch = meta.tryGetString("general.architecture");
    ASSERT_TRUE(arch.has_value());
    EXPECT_NE(arch.value(), "bitnet");
  });
}

TEST_F(ModelMetadataTest, DiskSingleFile_BitnetModel_ArchitectureIsBitnet) {
  REQUIRE_MODEL(bitnetModel_);
  parseDiskSingleFile(bitnetModel_.path, [](const ModelMetaData& meta) {
    auto arch = meta.tryGetString("general.architecture");
    ASSERT_TRUE(arch.has_value());
    EXPECT_EQ(arch.value(), "bitnet");
  });
}

// ---- Disk single file – isU32OneOf: quantization per architecture ----
//
// Quantization is stored as a u32 under "general.file_type" (llama_ftype).
// Model architecture ("general.architecture") is a string field and therefore
// cannot be queried with isU32OneOf; it is exercised here implicitly by running
// the same checker against models from different architecture families.
//
// Known models exercised:
//   Llama-3.2-1B-Instruct-Q4_0  (llama  arch, LLAMA_FTYPE_MOSTLY_Q4_0)
//   Qwen3-0.6B-Q8_0             (qwen3  arch, LLAMA_FTYPE_MOSTLY_Q8_0)
//   bitnet_b1_58-large-TQ2_0    (bitnet arch, LLAMA_FTYPE_MOSTLY_TQ2_0)

// Adreno 800+ requires Vulkan to be available when fine-tuning with any of
// the quantization types listed here. The checker is shared across all
// architecture-specific tests below so that every new model variant
// automatically exercises the same gate.
static const MetaChecker kVulkanNeededForFinetuneAdreno800Plus =
    [](const ModelMetaData& meta) {
      EXPECT_TRUE(meta.isU32OneOf(
          "general.file_type",
          {static_cast<uint32_t>(LLAMA_FTYPE_ALL_F32),
           static_cast<uint32_t>(LLAMA_FTYPE_MOSTLY_F16),
           static_cast<uint32_t>(LLAMA_FTYPE_MOSTLY_Q4_0),
           static_cast<uint32_t>(LLAMA_FTYPE_MOSTLY_Q4_1),
           static_cast<uint32_t>(LLAMA_FTYPE_MOSTLY_Q8_0),
           static_cast<uint32_t>(LLAMA_FTYPE_MOSTLY_TQ1_0),
           static_cast<uint32_t>(LLAMA_FTYPE_MOSTLY_TQ2_0)}));
    };

// llama architecture – Llama-3.2-1B-Instruct-Q4_0

TEST_F(
    ModelMetadataTest,
    DiskSingleFile_LlamaArch_Q4_0_VulkanNeededForFinetuneAdreno800Plus) {
  REQUIRE_MODEL(normalModel_);
  parseDiskSingleFile(normalModel_.path, kVulkanNeededForFinetuneAdreno800Plus);
}

TEST_F(ModelMetadataTest, DiskSingleFile_LlamaArch_IsSpecificallyQ4_0) {
  REQUIRE_MODEL(normalModel_);
  parseDiskSingleFile(normalModel_.path, [](const ModelMetaData& meta) {
    EXPECT_TRUE(meta.isU32OneOf(
        "general.file_type", {static_cast<uint32_t>(LLAMA_FTYPE_MOSTLY_Q4_0)}));
    EXPECT_FALSE(meta.isU32OneOf(
        "general.file_type",
        {static_cast<uint32_t>(LLAMA_FTYPE_MOSTLY_TQ2_0),
         static_cast<uint32_t>(LLAMA_FTYPE_MOSTLY_TQ1_0)}));
  });
}

// qwen3 architecture – Qwen3-0.6B-Q8_0

TEST_F(
    ModelMetadataTest,
    DiskSingleFile_Qwen3Arch_Q8_0_VulkanNeededForFinetuneAdreno800Plus) {
  REQUIRE_MODEL(qwen3Model_);
  parseDiskSingleFile(qwen3Model_.path, kVulkanNeededForFinetuneAdreno800Plus);
}

TEST_F(ModelMetadataTest, DiskSingleFile_Qwen3Arch_IsSpecificallyQ8_0) {
  REQUIRE_MODEL(qwen3Model_);
  parseDiskSingleFile(qwen3Model_.path, [](const ModelMetaData& meta) {
    EXPECT_TRUE(meta.isU32OneOf(
        "general.file_type", {static_cast<uint32_t>(LLAMA_FTYPE_MOSTLY_Q8_0)}));
    EXPECT_FALSE(meta.isU32OneOf(
        "general.file_type",
        {static_cast<uint32_t>(LLAMA_FTYPE_MOSTLY_Q4_0),
         static_cast<uint32_t>(LLAMA_FTYPE_MOSTLY_TQ2_0),
         static_cast<uint32_t>(LLAMA_FTYPE_MOSTLY_TQ1_0)}));
  });
}

// bitnet architecture – bitnet_b1_58-large-TQ2_0

TEST_F(
    ModelMetadataTest,
    DiskSingleFile_BitnetArch_TQ2_0_VulkanNeededForFinetuneAdreno800Plus) {
  REQUIRE_MODEL(bitnetModel_);
  parseDiskSingleFile(bitnetModel_.path, kVulkanNeededForFinetuneAdreno800Plus);
}

TEST_F(ModelMetadataTest, DiskSingleFile_BitnetArch_IsSpecificallyTQ2_0) {
  REQUIRE_MODEL(bitnetModel_);
  parseDiskSingleFile(bitnetModel_.path, [](const ModelMetaData& meta) {
    EXPECT_TRUE(meta.isU32OneOf(
        "general.file_type",
        {static_cast<uint32_t>(LLAMA_FTYPE_MOSTLY_TQ2_0)}));
    EXPECT_FALSE(meta.isU32OneOf(
        "general.file_type",
        {static_cast<uint32_t>(LLAMA_FTYPE_MOSTLY_Q4_0),
         static_cast<uint32_t>(LLAMA_FTYPE_MOSTLY_Q8_0),
         static_cast<uint32_t>(LLAMA_FTYPE_MOSTLY_F16),
         static_cast<uint32_t>(LLAMA_FTYPE_ALL_F32)}));
  });
}
