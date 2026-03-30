#include <filesystem>
#include <fstream>
#include <functional>
#include <future>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <thread>

#include <gtest/gtest.h>
#include <llama-cpp.h>

#include "model-interface/AsyncWeightsLoader.hpp"
#include "model-interface/LlamaModel.hpp"
#include "model-interface/ModelMetadata.hpp"
#include "test_common.hpp"

namespace fs = std::filesystem;

// ---- MockAsyncWeightsLoader ----
//
// Overrides fulfillSplitFuture so tests never touch the global promise
// registry. fulfilledFilenames records every call for assertion;
// waitForFulfillCount() synchronises with the detached thread used by the
// sharded path.

class MockAsyncWeightsLoader : public AsyncWeightsLoader {
public:
  using AsyncWeightsLoader::AsyncWeightsLoader;

  std::multiset<std::string> fulfilledFilenames;

  void waitForFulfillCount(std::size_t n) {
    std::unique_lock<std::mutex> lock(mu_);
    cv_.wait(lock, [&] { return fulfilledFilenames.size() >= n; });
  }

protected:
  void fulfillSplitFuture(
      const std::string& filename, std::unique_ptr<Buf>&&) override {
    {
      std::lock_guard<std::mutex> lock(mu_);
      fulfilledFilenames.insert(filename);
    }
    cv_.notify_all();
  }

private:
  std::mutex mu_;
  std::condition_variable cv_;
};

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

    // MedGemma is a Gemma-3-based model used in integration tests.
    // https://huggingface.co/unsloth/medgemma-4b-it-GGUF
    gemma3Model_ =
        MP("medgemma-4b-it-Q4_1.gguf",
           "GEMMA3_MODEL_PATH",
           MP::OnMissing::Skip,
           "https://huggingface.co/unsloth/medgemma-4b-it-GGUF");

    // Sharded models: constructor expands the shard list; resolveShardPaths
    // then fills in absolute paths (requires LlamaModel, kept out of
    // test_common.hpp to avoid pulling in the heavy llama headers there).
    // https://huggingface.co/jmb95/Qwen3-0.6B-UD-IQ1_S-sharded
    normalModelSharded_ =
        MP("Qwen3-0.6B-UD-IQ1_S-00001-of-00003.gguf",
           "SHARDED_MODEL_FIRST_SHARD_PATH",
           MP::OnMissing::Skip,
           "https://huggingface.co/jmb95/Qwen3-0.6B-UD-IQ-1_S-sharded",
           true /* isSharded */);
    if (normalModelSharded_.found())
      LlamaModel::resolveShardPaths(
          normalModelSharded_.shards, normalModelSharded_.path);

    // https://huggingface.co/jmb95/bitnet_b1_58-large-TQ2_0-sharded
    bitnetModelSharded_ =
        MP("bitnet_b1_58-large-TQ2_0-00001-of-00008.gguf",
           nullptr,
           MP::OnMissing::Skip,
           "https://huggingface.co/jmb95/bitnet_b1_58-large-TQ2_0-sharded",
           true /* isSharded */);
    if (bitnetModelSharded_.found())
      LlamaModel::resolveShardPaths(
          bitnetModelSharded_.shards, bitnetModelSharded_.path);
  }

  test_common::TestModelPath normalModel_;
  test_common::TestModelPath bitnetModel_;
  test_common::TestModelPath qwen3Model_;
  test_common::TestModelPath gemma3Model_;
  test_common::TestModelPath normalModelSharded_;
  test_common::TestModelPath bitnetModelSharded_;

  // ---- Parse-and-check helpers ----
  //
  // Each helper drives one parse strategy and calls check(meta) at the end.
  // Use ASSERT_NO_FATAL_FAILURE() at the call site if early exit on fatal
  // assertion failure is needed.

  void parseDiskSingleFile(const std::string& path, MetaChecker check) {
    GGUFShards emptyShards;
    ModelMetaData meta;
    meta.parse(path, emptyShards, false /* isStreaming */, "Test");
    check(meta);
  }

  void parseDiskShards(
      const std::string& firstShardPath, const GGUFShards& shardsWithPaths,
      MetaChecker check) {
    ModelMetaData meta;
    meta.parse(
        firstShardPath, shardsWithPaths, false /* isStreaming */, "Test");
    check(meta);
  }

  // Note: in real scenarios the GGUF is streamed from the network; a
  // file-backed streambuf is used here so metadata parsing reads on demand
  // without copying the entire file into memory.
  void parseStreamingSingleFile(const std::string& path, MetaChecker check) {
    std::unique_ptr<std::basic_streambuf<char>> streambuf =
        test_common::readFileToStreambufBinary(path);
    ASSERT_NE(streambuf, nullptr);
    GGUFShards emptyShards;
    BorrowablePtr<std::basic_streambuf<char>> firstFileFromGgufStream(
        std::move(streambuf));
    ModelMetaData meta;
    std::thread lenderThread([&meta, &firstFileFromGgufStream]() {
      meta.firstFileFromGgufStreamState.provide(firstFileFromGgufStream);
    });
    meta.parse(path, emptyShards, true /* isStreaming */, "Test");
    lenderThread.join();
    check(meta);
  }

  void parseStreamingShards(
      const std::string& firstShardPath, const GGUFShards& shardsWithPaths,
      MetaChecker check) {
    std::unique_ptr<std::basic_streambuf<char>> streambuf =
        test_common::readFileToStreambufBinary(
            shardsWithPaths.gguf_files.front());
    ASSERT_NE(streambuf, nullptr);
    BorrowablePtr<std::basic_streambuf<char>> firstFileFromGgufStream(
        std::move(streambuf));
    ModelMetaData meta;
    std::thread lenderThread([&meta, &firstFileFromGgufStream]() {
      meta.firstFileFromGgufStreamState.provide(firstFileFromGgufStream);
    });
    meta.parse(firstShardPath, shardsWithPaths, true /* isStreaming */, "Test");
    lenderThread.join();
    check(meta);
  }

  // setWeightsForFile is called before parse() (mirrors real delayed-load
  // usage). Invariants — shard is in extracted map, fulfillSplitFuture is
  // never called for single-GGUF — are asserted by the helper itself.
  void parseAsyncLoaderSingleFile(const std::string& path, MetaChecker check) {
    std::unique_ptr<std::basic_streambuf<char>> singleFileStreambuf =
        test_common::readFileToStreambufBinary(path);
    ASSERT_NE(singleFileStreambuf, nullptr);

    const std::string filename = fs::path(path).filename().string();
    GGUFShards emptyShards;
    InitLoader initLoader;
    ModelMetaData meta;
    MockAsyncWeightsLoader loader(emptyShards, initLoader, "test", &meta);

    loader.setWeightsForFile(filename, std::move(singleFileStreambuf));
    meta.parse(path, emptyShards, true /* isStreaming */, "Test");
    std::map<std::string, std::unique_ptr<std::basic_streambuf<char>>>
        extracted = loader.extractIndividualStreamedFiles();
    check(meta);
    EXPECT_NE(extracted.find(filename), extracted.end());
    EXPECT_TRUE(loader.fulfilledFilenames.empty());
  }

  // parse() is run on a separate thread because it blocks at wait() until
  // setWeightsForFile() provides the first shard via lendFirstShard().
  // waitForFulfillCount(1) makes assertions on fulfilledFilenames race-free.
  void parseAsyncLoaderShards(
      const std::string& firstShardPath, const GGUFShards& shardsWithPaths,
      MetaChecker check) {
    GGUFShards shards = GGUFShards::expandGGUFIntoShards(firstShardPath);
    const std::string firstShardFilename = shards.gguf_files.front();

    std::unique_ptr<std::basic_streambuf<char>> firstShardBuf =
        test_common::readFileToStreambufBinary(
            shardsWithPaths.gguf_files.front());
    ASSERT_NE(firstShardBuf, nullptr);

    InitLoader initLoader;
    const std::string loadingContext =
        InitLoader::getLoadingContext("TestShards");
    ModelMetaData meta;
    MockAsyncWeightsLoader loader(shards, initLoader, loadingContext, &meta);

    std::thread parseThread([&]() {
      meta.parse(
          firstShardPath, shardsWithPaths, true /* isStreaming */, "Test");
    });

    loader.setWeightsForFile(firstShardFilename, std::move(firstShardBuf));
    parseThread.join();
    loader.waitForFulfillCount(1);

    check(meta);
    EXPECT_EQ(loader.fulfilledFilenames.count(firstShardFilename), 1u);
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
  parseDiskShards(
      normalModelSharded_.path,
      normalModelSharded_.shards,
      [](const ModelMetaData& meta) {
        EXPECT_FALSE(meta.hasOneBitQuantization());
      });
}

TEST_F(ModelMetadataTest, DiskShards_BitnetModel_HasOneBitQuantizationTrue) {
  REQUIRE_MODEL(bitnetModelSharded_);
  parseDiskShards(
      bitnetModelSharded_.path,
      bitnetModelSharded_.shards,
      [](const ModelMetaData& meta) {
        EXPECT_TRUE(meta.hasOneBitQuantization());
      });
}

// ---- Streaming single file ----

TEST_F(
    ModelMetadataTest,
    StreamingSingleFile_NormalModel_HasOneBitQuantizationFalse) {
  REQUIRE_MODEL(normalModel_);
  parseStreamingSingleFile(normalModel_.path, [](const ModelMetaData& meta) {
    EXPECT_FALSE(meta.hasOneBitQuantization());
  });
}

TEST_F(
    ModelMetadataTest,
    StreamingSingleFile_BitnetModel_HasOneBitQuantizationTrue) {
  REQUIRE_MODEL(bitnetModel_);
  parseStreamingSingleFile(bitnetModel_.path, [](const ModelMetaData& meta) {
    EXPECT_TRUE(meta.hasOneBitQuantization());
  });
}

// ---- Streaming shards ----

TEST_F(
    ModelMetadataTest, StreamingShards_NormalModel_HasOneBitQuantizationFalse) {
  REQUIRE_MODEL(normalModelSharded_);
  parseStreamingShards(
      normalModelSharded_.path,
      normalModelSharded_.shards,
      [](const ModelMetaData& meta) {
        EXPECT_FALSE(meta.hasOneBitQuantization());
      });
}

TEST_F(
    ModelMetadataTest, StreamingShards_BitnetModel_HasOneBitQuantizationTrue) {
  REQUIRE_MODEL(bitnetModelSharded_);
  parseStreamingShards(
      bitnetModelSharded_.path,
      bitnetModelSharded_.shards,
      [](const ModelMetaData& meta) {
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

TEST_F(
    ModelMetadataTest,
    StreamingSingleFile_NormalModel_ArchitectureIsNotBitnet) {
  REQUIRE_MODEL(normalModel_);
  parseStreamingSingleFile(normalModel_.path, [](const ModelMetaData& meta) {
    auto arch = meta.tryGetString("general.architecture");
    ASSERT_TRUE(arch.has_value());
    EXPECT_NE(arch.value(), "bitnet");
  });
}

TEST_F(
    ModelMetadataTest, StreamingSingleFile_BitnetModel_ArchitectureIsBitnet) {
  REQUIRE_MODEL(bitnetModel_);
  parseStreamingSingleFile(bitnetModel_.path, [](const ModelMetaData& meta) {
    auto arch = meta.tryGetString("general.architecture");
    ASSERT_TRUE(arch.has_value());
    EXPECT_EQ(arch.value(), "bitnet");
  });
}

// ---- AsyncWeightsLoader: streaming single file ----
//
// setWeightsForFile is called during the download phase (before activate()),
// so by the time parse() runs it finds the single file already in
// streamedFiles_ and the wait() flag already set.

TEST_F(
    ModelMetadataTest,
    AsyncLoader_SingleFile_NormalModel_MetadataParsedAndShardAvailable) {
  REQUIRE_MODEL(normalModel_);
  parseAsyncLoaderSingleFile(normalModel_.path, [](const ModelMetaData& meta) {
    EXPECT_FALSE(meta.hasOneBitQuantization());
  });
}

TEST_F(
    ModelMetadataTest,
    AsyncLoader_SingleFile_BitnetModel_MetadataParsedAndShardAvailable) {
  REQUIRE_MODEL(bitnetModel_);
  parseAsyncLoaderSingleFile(bitnetModel_.path, [](const ModelMetaData& meta) {
    EXPECT_TRUE(meta.hasOneBitQuantization());
  });
}

TEST_F(
    ModelMetadataTest,
    AsyncLoader_SingleFile_NoMetadata_ShardStoredWithoutLending) {
  REQUIRE_MODEL(normalModel_);
  std::unique_ptr<std::basic_streambuf<char>> singleFileStreambuf =
      test_common::readFileToStreambufBinary(normalModel_.path);
  ASSERT_NE(singleFileStreambuf, nullptr);

  const std::string filename = fs::path(normalModel_.path).filename().string();
  GGUFShards emptyShards;
  InitLoader initLoader;
  // No ModelMetaData — lending is skipped entirely.
  MockAsyncWeightsLoader loader(emptyShards, initLoader, "test-no-meta");

  loader.setWeightsForFile(filename, std::move(singleFileStreambuf));

  std::map<std::string, std::unique_ptr<std::basic_streambuf<char>>> extracted =
      loader.extractIndividualStreamedFiles();
  EXPECT_TRUE(loader.isStreaming());
  EXPECT_NE(extracted.find(filename), extracted.end());
  EXPECT_TRUE(loader.fulfilledFilenames.empty());
}

// ---- AsyncWeightsLoader: streaming shards ----

TEST_F(ModelMetadataTest, AsyncLoader_Shards_NormalModel_MetadataParsed) {
  REQUIRE_MODEL(normalModelSharded_);
  parseAsyncLoaderShards(
      normalModelSharded_.path,
      normalModelSharded_.shards,
      [](const ModelMetaData& meta) {
        EXPECT_FALSE(meta.hasOneBitQuantization());
      });
}

TEST_F(ModelMetadataTest, AsyncLoader_Shards_BitnetModel_MetadataParsed) {
  REQUIRE_MODEL(bitnetModelSharded_);
  parseAsyncLoaderShards(
      bitnetModelSharded_.path,
      bitnetModelSharded_.shards,
      [](const ModelMetaData& meta) {
        EXPECT_TRUE(meta.hasOneBitQuantization());
      });
}

TEST_F(
    ModelMetadataTest,
    AsyncLoader_Shards_FirstShardWorkerBlocksUntilMetadataReleases) {
  REQUIRE_MODEL(normalModelSharded_);

  GGUFShards shards =
      GGUFShards::expandGGUFIntoShards(normalModelSharded_.path);
  const std::string firstShardFilename = shards.gguf_files.front();

  std::unique_ptr<std::basic_streambuf<char>> firstShardBuf =
      test_common::readFileToStreambufBinary(
          normalModelSharded_.shards.gguf_files.front());
  ASSERT_NE(firstShardBuf, nullptr);

  InitLoader initLoader;
  const std::string loadingContext =
      InitLoader::getLoadingContext("TestFirstShardBlock");
  ModelMetaData meta;
  MockAsyncWeightsLoader loader(shards, initLoader, loadingContext, &meta);

  loader.setWeightsForFile(firstShardFilename, std::move(firstShardBuf));

  // Before metadata parse runs, the first-shard worker should still be waiting
  // for release, so public extraction (which joins internally) must block.
  auto extractFuture = std::async(std::launch::async, [&loader]() {
    return loader.extractIndividualStreamedFiles();
  });
  EXPECT_EQ(
      extractFuture.wait_for(std::chrono::milliseconds(150)),
      std::future_status::timeout);

  // Once metadata parsing consumes/releases the borrowed first shard, the
  // worker should finish and extraction should complete.
  auto parseFuture = std::async(std::launch::async, [&]() {
    meta.parse(
        normalModelSharded_.path,
        normalModelSharded_.shards,
        true /* isStreaming */,
        "Test");
  });
  ASSERT_EQ(
      parseFuture.wait_for(std::chrono::seconds(10)),
      std::future_status::ready);
  EXPECT_NO_THROW(parseFuture.get());

  ASSERT_EQ(
      extractFuture.wait_for(std::chrono::seconds(5)),
      std::future_status::ready);
  EXPECT_NO_THROW({
    auto extracted = extractFuture.get();
    EXPECT_TRUE(extracted.empty());
  });

  loader.waitForFulfillCount(1);
  EXPECT_EQ(loader.fulfilledFilenames.count(firstShardFilename), 1u);
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
//   medgemma-4b-it-Q4_1         (gemma3 arch, LLAMA_FTYPE_MOSTLY_Q4_1)
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

// gemma3 architecture – medgemma-4b-it-Q4_1
// Set GEMMA3_MODEL_PATH or place medgemma-4b-it-Q4_1.gguf in models/unit-test.

TEST_F(
    ModelMetadataTest,
    DiskSingleFile_Gemma3Arch_Q4_1_VulkanNeededForFinetuneAdreno800Plus) {
  REQUIRE_MODEL(gemma3Model_);
  parseDiskSingleFile(gemma3Model_.path, kVulkanNeededForFinetuneAdreno800Plus);
}

TEST_F(ModelMetadataTest, DiskSingleFile_Gemma3Arch_IsSpecificallyQ4_1) {
  REQUIRE_MODEL(gemma3Model_);
  parseDiskSingleFile(gemma3Model_.path, [](const ModelMetaData& meta) {
    EXPECT_TRUE(meta.isU32OneOf(
        "general.file_type", {static_cast<uint32_t>(LLAMA_FTYPE_MOSTLY_Q4_1)}));
    EXPECT_FALSE(meta.isU32OneOf(
        "general.file_type",
        {static_cast<uint32_t>(LLAMA_FTYPE_MOSTLY_Q4_0),
         static_cast<uint32_t>(LLAMA_FTYPE_MOSTLY_Q8_0),
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
