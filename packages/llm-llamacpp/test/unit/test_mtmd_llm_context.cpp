#include <filesystem>
#include <fstream>
#include <iterator>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

#include <gtest/gtest.h>
#include <inference-addon-cpp/Errors.hpp>

#include "model-interface/LlamaModel.hpp"
#include "model-interface/MtmdLlmContext.hpp"
#include "model-interface/SequenceDriver.hpp"
#include "test_common.hpp"
#include "test_internal_peers.hpp"

using test_common::getStatValue;

namespace fs = std::filesystem;

namespace {
constexpr uint32_t kQwen35MultimodalPrefillCells = 2899;
constexpr llama_pos kQwen35MultimodalPrefillPosMax = 90;

std::vector<uint8_t> readBinaryFile(const fs::path& path) {
  std::ifstream stream(path, std::ios::binary);
  return {
      std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>()};
}

fs::path multimodalTestImagePath() {
  const fs::path packageRelative = "media/fruitPlate.png";
  if (fs::exists(packageRelative)) {
    return packageRelative;
  }

#ifdef TEST_BINARY_DIR
  const fs::path binaryRelative = fs::path(TEST_BINARY_DIR) / ".." / ".." /
                                  ".." / "media" / "fruitPlate.png";
  if (fs::exists(binaryRelative)) {
    return binaryRelative.lexically_normal();
  }
#endif

  return "packages/llm-llamacpp/media/fruitPlate.png";
}
} // namespace

class MtmdLlmContextTest : public ::testing::Test {
protected:
  void SetUp() override {
    config_files["device"] = test_common::getTestDevice();
    config_files["ctx_size"] = "2048";
    config_files["gpu_layers"] = test_common::getTestGpuLayers();
    config_files["n_predict"] = "10";

    test_model_path = test_common::BaseTestModelPath::get(
        "SmolVLM-500M-Instruct-Q8_0.gguf", "SmolVLM-500M-Instruct.gguf");
    test_projection_path = test_common::BaseTestModelPath::get(
        "mmproj-SmolVLM-500M-Instruct-Q8_0.gguf",
        "mmproj-SmolVLM-500M-Instruct.gguf");

    fs::path backendDir;
#ifdef TEST_BINARY_DIR
    backendDir = fs::path(TEST_BINARY_DIR);
#else
    backendDir = fs::current_path() / "build" / "test" / "unit";
#endif

    config_files["backendsDir"] = backendDir.string();
  }

  std::unordered_map<std::string, std::string> config_files;
  std::string test_model_path;
  std::string test_projection_path;

  bool hasValidModel() {
    return fs::exists(test_model_path) && fs::exists(test_projection_path);
  }

  bool hasValidQwen35Model() {
    return fs::exists(qwen35_model_path) && fs::exists(qwen35_projection_path);
  }

  std::unique_ptr<LlamaModel> createModel() {
    if (!hasValidModel()) {
      return nullptr;
    }
    std::string modelPath = test_model_path;
    std::string projectionPath = test_projection_path;
    auto configCopy = config_files;
    auto model = std::make_unique<LlamaModel>(
        std::move(modelPath), std::move(projectionPath), std::move(configCopy));
    model->waitForLoadInitialization();
    if (!model->isLoaded()) {
      return nullptr;
    }
    return model;
  }

  std::unique_ptr<LlamaModel> createQwen35Model() {
    if (!hasValidQwen35Model()) {
      return nullptr;
    }
    std::string modelPath = qwen35_model_path;
    std::string projectionPath = qwen35_projection_path;
    auto configCopy = config_files;
    configCopy["ctx_size"] = "4096";
    auto model = std::make_unique<LlamaModel>(
        std::move(modelPath), std::move(projectionPath), std::move(configCopy));
    model->waitForLoadInitialization();
    if (!model->isLoaded()) {
      return nullptr;
    }
    return model;
  }

  std::string qwen35_model_path =
      test_common::BaseTestModelPath::get("Qwen3.5-0.8B-Q8_0.gguf");
  std::string qwen35_projection_path =
      test_common::BaseTestModelPath::get("mmproj-Qwen3.5-0.8B-F16.gguf");
};

TEST_F(MtmdLlmContextTest, Constructor) {
  if (!hasValidModel()) {
    FAIL() << "Multimodal model or projection file not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  EXPECT_TRUE(model->isLoaded());
}

TEST_F(MtmdLlmContextTest, ProcessWithStringInput) {
  if (!hasValidModel()) {
    FAIL() << "Multimodal model or projection file not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt prompt;
  prompt.input = R"([{"role": "user", "content": "Hello, how are you?"}])";
  EXPECT_NO_THROW({
    std::string output = model->processPrompt(prompt);
    EXPECT_GE(output.length(), 0);
    auto stats = model->runtimeStats();
    EXPECT_GE(stats.size(), 0);
  });
}

TEST_F(MtmdLlmContextTest, ProcessWithCallback) {
  if (!hasValidModel()) {
    FAIL() << "Multimodal model or projection file not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  std::vector<std::string> generatedTokens;

  LlamaModel::Prompt prompt;
  prompt.input = R"([{"role": "user", "content": "Hello"}])";
  prompt.outputCallback = [&generatedTokens](const std::string& token) {
    generatedTokens.push_back(token);
  };

  EXPECT_NO_THROW({
    std::string output = model->processPrompt(prompt);
    EXPECT_GE(output.length(), 0);
    EXPECT_GT(generatedTokens.size(), 0);
    auto stats = model->runtimeStats();
    EXPECT_GE(stats.size(), 0);
  });
}

TEST_F(MtmdLlmContextTest, ProcessAndGetRuntimeStats) {
  if (!hasValidModel()) {
    FAIL() << "Multimodal model or projection file not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt prompt;
  prompt.input = R"([{"role": "user", "content": "Hello"}])";
  EXPECT_NO_THROW({
    std::string output = model->processPrompt(prompt);
    EXPECT_GE(output.length(), 0);
    auto stats = model->runtimeStats();
    EXPECT_GE(stats.size(), 0);
  });
}

TEST_F(MtmdLlmContextTest, LoadMediaBinary) {
  if (!hasValidModel()) {
    FAIL() << "Multimodal model or projection file not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  std::vector<uint8_t> imageData = {0xFF, 0xD8, 0xFF, 0xE0};
  LlamaModel::Prompt prompt;
  prompt.input = R"([{"role": "user", "content": "What is this?"}])";
  prompt.media.push_back(std::move(imageData));
  EXPECT_THROW({ model->processPrompt(prompt); }, qvac_errors::StatusError);
}

TEST_F(MtmdLlmContextTest, LoadMediaFile) {
  if (!hasValidModel()) {
    FAIL() << "Multimodal model or projection file not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt prompt;
  prompt.input =
      R"([{"type": "media", "content": "nonexistent_image.jpg"}, {"role": "user", "content": "What is this?"}])";
  EXPECT_THROW({ model->processPrompt(prompt); }, qvac_errors::StatusError);
}

TEST_F(MtmdLlmContextTest, ResetState) {
  if (!hasValidModel()) {
    FAIL() << "Multimodal model or projection file not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt prompt;
  prompt.input = R"([{"role": "user", "content": "Hello"}])";
  EXPECT_NO_THROW({
    std::string output = model->processPrompt(prompt);
    EXPECT_GE(output.length(), 0);
    auto stats = model->runtimeStats();
    EXPECT_GE(stats.size(), 0);
  });

  EXPECT_NO_THROW(model->reset());

  LlamaModel::Prompt prompt2;
  prompt2.input = R"([{"role": "user", "content": "Another hello"}])";
  EXPECT_NO_THROW({
    std::string output2 = model->processPrompt(prompt2);
    EXPECT_GE(output2.length(), 0);
    auto stats2 = model->runtimeStats();
    EXPECT_GE(stats2.size(), 0);
  });
}

TEST_F(MtmdLlmContextTest, ResetMedia) {
  if (!hasValidModel()) {
    FAIL() << "Multimodal model or projection file not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  std::vector<uint8_t> imageData = {0xFF, 0xD8, 0xFF, 0xE0};
  LlamaModel::Prompt mediaPrompt;
  mediaPrompt.input = R"([{"role": "user", "content": "What is this?"}])";
  mediaPrompt.media.push_back(std::move(imageData));
  EXPECT_THROW(
      { model->processPrompt(mediaPrompt); }, qvac_errors::StatusError);

  LlamaModel::Prompt prompt;
  prompt.input = R"([{"role": "user", "content": "Hello"}])";
  EXPECT_NO_THROW({
    std::string output = model->processPrompt(prompt);
    EXPECT_GE(output.length(), 0);
    auto stats = model->runtimeStats();
    EXPECT_GE(stats.size(), 0);
  });
}

TEST_F(MtmdLlmContextTest, MultimodalMessages) {
  if (!hasValidModel()) {
    FAIL() << "Multimodal model or projection file not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt prompt;
  prompt.input =
      R"([{"role": "user", "content": "What do you see in this image?"}])";
  EXPECT_NO_THROW({
    std::string output = model->processPrompt(prompt);
    EXPECT_GE(output.length(), 0);
    auto stats = model->runtimeStats();
    EXPECT_GE(stats.size(), 0);
  });
}

TEST_F(MtmdLlmContextTest, CacheTokensMatchesLlamaMemoryTokenCount) {
  if (!hasValidModel()) {
    FAIL() << "Multimodal model or projection file not found";
  }

  const fs::path imagePath = multimodalTestImagePath();
  if (!fs::exists(imagePath)) {
    FAIL() << "Multimodal test image not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt prompt;
  prompt.input =
      R"([{"role": "user", "type": "media", "content": ""},)"
      R"( {"role": "user", "content": "Describe this image briefly."}])";
  prompt.media.push_back(readBinaryFile(imagePath));

  std::string output = model->processPrompt(prompt);
  EXPECT_GE(output.length(), 0);

  auto* mem = llama_get_memory(model->getContext());
  ASSERT_NE(mem, nullptr);

  const auto expectedCacheTokens =
      static_cast<double>(llama_memory_seq_token_count(mem, 0));
  const auto stats = model->runtimeStats();

  EXPECT_EQ(getStatValue(stats, "CacheTokens"), expectedCacheTokens);
}

TEST_F(MtmdLlmContextTest, Qwen35MultimodalReportsMemoryTokenCountAndPosMax) {
  if (!hasValidQwen35Model()) {
    FAIL() << "Qwen3.5 multimodal model or projection file not found";
  }

  const fs::path imagePath = multimodalTestImagePath();
  if (!fs::exists(imagePath)) {
    FAIL() << "Multimodal test image not found";
  }

  auto model = createQwen35Model();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt prompt;
  prompt.input =
      R"([{"role": "user", "type": "media", "content": ""},)"
      R"( {"role": "user", "content": "Describe this image in one sentence."}])";
  prompt.prefill = true;
  prompt.media.push_back(readBinaryFile(imagePath));

  std::string output = model->processPrompt(prompt);
  EXPECT_TRUE(output.empty());

  auto* mem = llama_get_memory(model->getContext());
  ASSERT_NE(mem, nullptr);

  const uint32_t sequenceCells = llama_memory_seq_token_count(mem, 0);
  const uint32_t totalCells = llama_memory_seq_token_count(mem, -1);
  const llama_pos posMax = llama_memory_seq_pos_max(mem, 0);
  SCOPED_TRACE(
      "sequenceCells=" + std::to_string(sequenceCells) + ", totalCells=" +
      std::to_string(totalCells) + ", posMax=" + std::to_string(posMax));

  EXPECT_EQ(sequenceCells, kQwen35MultimodalPrefillCells);
  EXPECT_EQ(totalCells, kQwen35MultimodalPrefillCells);
  EXPECT_EQ(posMax, kQwen35MultimodalPrefillPosMax);

  const auto stats = model->runtimeStats();
  EXPECT_EQ(
      getStatValue(stats, "CacheTokens"), static_cast<double>(sequenceCells));
}

TEST_F(
    MtmdLlmContextTest,
    Qwen35MultimodalGenerationWithCacheKeyKeepsMemoryAfterGeneration) {
  if (!hasValidQwen35Model()) {
    FAIL() << "Qwen3.5 multimodal model or projection file not found";
  }

  const fs::path imagePath = multimodalTestImagePath();
  if (!fs::exists(imagePath)) {
    FAIL() << "Multimodal test image not found";
  }

  auto model = createQwen35Model();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  const fs::path cachePath =
      fs::temp_directory_path() / "qvac-qwen35-mtmd-generation-cache.bin";
  fs::remove(cachePath);

  LlamaModel::Prompt prompt;
  prompt.input =
      R"([{"role": "user", "type": "media", "content": ""},)"
      R"( {"role": "user", "content": "Describe this image in one sentence."}])";
  prompt.cacheKey = cachePath.string();
  prompt.saveCacheToDisk = true;
  prompt.media.push_back(readBinaryFile(imagePath));
  // This test validates that cacheKey keeps generated multimodal memory
  // resident after generation. The fixture's small n_predict can stop Qwen3.5
  // inside an unfinished reasoning block, which is covered by dedicated
  // remove_thinking_from_context tests; opt out here so the cache-residency
  // assertion remains focused on its original contract.
  prompt.generationParams.remove_thinking_from_context = false;

  std::string output = model->processPrompt(prompt);
  EXPECT_GE(output.length(), 0);

  auto* mem = llama_get_memory(model->getContext());
  ASSERT_NE(mem, nullptr);

  const uint32_t sequenceCells = llama_memory_seq_token_count(mem, 0);
  const uint32_t totalCells = llama_memory_seq_token_count(mem, -1);
  const llama_pos posMax = llama_memory_seq_pos_max(mem, 0);
  SCOPED_TRACE(
      "sequenceCells=" + std::to_string(sequenceCells) + ", totalCells=" +
      std::to_string(totalCells) + ", posMax=" + std::to_string(posMax));

  EXPECT_GT(sequenceCells, kQwen35MultimodalPrefillCells);
  EXPECT_EQ(totalCells, sequenceCells);
  EXPECT_GT(posMax, kQwen35MultimodalPrefillPosMax);

  const auto stats = model->runtimeStats();
  EXPECT_EQ(
      getStatValue(stats, "CacheTokens"), static_cast<double>(sequenceCells));

  fs::remove(cachePath);
}

// Multimodal hybrid (Qwen3.5) compaction. `MtmdLlmContext` shares the
// `ReasoningBlockCompactor` with `TextLlmContext` but applies its own
// post-compact bookkeeping (`current_.pos` / `cacheTokens` / protected-
// prefix). This pins the end-to-end multimodal compaction path:
//   * a reasoning-capable hybrid multimodal model produces a `<think>` block,
//   * end-of-prefill recurrent snapshot + restore + post-reasoning replay
//     succeeds for the multimodal context,
//   * `thinkingBlockDiscards` increments. Under the uniform hard-fail
//     contract (PR #2813) any compaction failure would throw
//     `qvac_errors::StatusError` from `processPrompt`, so the
//     `ASSERT_NO_THROW` below is the failure-path guard.
//
// Companion JS coverage lives in `gemma4.test.js` (pure-attention
// multimodal); this is the hybrid-multimodal C++ counterpart called out by
// the reviewer.
TEST_F(MtmdLlmContextTest, Qwen35MultimodalHonoursRemoveThinkingFromContext) {
  if (!hasValidQwen35Model()) {
    GTEST_SKIP() << "Qwen3.5 multimodal model or projection file not found";
  }
  const fs::path imagePath = multimodalTestImagePath();
  if (!fs::exists(imagePath)) {
    GTEST_SKIP() << "Multimodal test image not found";
  }

  // The fixture's default `n_predict=10` is too small for a reasoning
  // block to close — the SetUp budget was chosen for non-reasoning smoke
  // tests. Bump it (plus a tight `temp=0` + binary-answer prompt below)
  // so the model closes `</think>` and produces a visible answer within
  // a single test run. `createQwen35Model` snapshots the config map, so
  // the override is local to this test.
  config_files["n_predict"] = "1024";
  config_files["temp"] = "0";

  auto model = createQwen35Model();
  ASSERT_NE(model, nullptr) << "Qwen3.5 multimodal model failed to load";
  auto* base = LlamaModelTestPeer::llmContext(*model);
  ASSERT_NE(base, nullptr);
  auto* ctx = dynamic_cast<MtmdLlmContext*>(base);
  ASSERT_NE(ctx, nullptr)
      << "single-prompt context for Qwen3.5 VLM must be MTMD";

  const fs::path cachePath =
      fs::temp_directory_path() / "qvac-qwen35-mtmd-thinking-compaction.bin";
  fs::remove(cachePath);

  LlamaModel::Prompt prompt;
  // Binary-answer prompt: encourages the model to close reasoning quickly
  // rather than producing a long description that risks blowing past
  // `n_predict` before `</think>` lands. Mirrors the gemma4 integration
  // test's "Answer in one word" pattern.
  prompt.input =
      R"([{"role": "system", "content": "Answer with just one word: yes or no."},)"
      R"( {"role": "user", "type": "media", "content": ""},)"
      R"( {"role": "user", "content": "Is there fruit in this image?"}])";
  prompt.cacheKey = cachePath.string();
  prompt.saveCacheToDisk = true;
  prompt.media.push_back(readBinaryFile(imagePath));
  prompt.generationParams.remove_thinking_from_context = true;

  std::string output;
  ASSERT_NO_THROW({ output = model->processPrompt(prompt); });
  EXPECT_GT(output.length(), 0u)
      << "multimodal compaction must not break generation";

  const auto stats = model->runtimeStats();
  const double discards = getStatValue(stats, "thinkingBlockDiscards");
  auto* mem = llama_get_memory(model->getContext());
  ASSERT_NE(mem, nullptr);
  const llama_seq_id seqId = ctx->getSeqId();
  const llama_pos posMax = llama_memory_seq_pos_max(mem, seqId);
  const auto sequenceCells =
      static_cast<llama_pos>(llama_memory_seq_token_count(mem, seqId));
  SCOPED_TRACE(
      "thinkingBlockDiscards=" + std::to_string(discards) +
      ", nPast=" + std::to_string(ctx->getNPast()) +
      ", cacheTokens=" + std::to_string(ctx->getCacheTokens()) +
      ", firstMsgTokens=" + std::to_string(ctx->getFirstMsgTokens()) +
      ", firstMsgCacheTokens=" + std::to_string(ctx->getFirstMsgCacheTokens()) +
      ", seqPosMax=" + std::to_string(posMax) +
      ", sequenceCells=" + std::to_string(sequenceCells) +
      ", output (first 200 chars): " + output.substr(0, 200));

  // Under the uniform hard-fail contract, any compaction failure
  // (snapshot capture, restore underflow, or replay rejection) would
  // have thrown `qvac_errors::StatusError` from `processPrompt` and
  // failed the `ASSERT_NO_THROW` above. Reaching this point means the
  // compaction path completed cleanly.
  ASSERT_NE(output.find("</think>"), std::string::npos)
      << "this test must reach a closed reasoning span; otherwise it does not "
         "exercise MTMD compaction bookkeeping";
  EXPECT_GE(discards, 1.0)
      << "Qwen3.5 multimodal with remove_thinking_from_context=true "
         "must compact at least one thinking block once </think> lands";
  EXPECT_GT(sequenceCells, 0)
      << "cacheKey must keep compacted MTMD memory resident for bookkeeping "
         "assertions";
  EXPECT_GT(ctx->getNPast(), 0)
      << "context must not have reset before post-compaction bookkeeping "
         "assertions";
  EXPECT_GT(ctx->getCacheTokens(), 0)
      << "cache token bookkeeping must remain resident after compaction";
  EXPECT_EQ(ctx->getCacheTokens(), sequenceCells)
      << "MTMD cacheTokens must be refreshed from llama memory after "
         "compaction";
  EXPECT_EQ(ctx->getNPast(), posMax + 1)
      << "MTMD current_.pos must match the compacted sequence cursor";
  EXPECT_LE(ctx->getFirstMsgTokens(), ctx->getNPast())
      << "protected text prefix must not extend beyond compacted position";
  EXPECT_LE(ctx->getFirstMsgCacheTokens(), ctx->getCacheTokens())
      << "protected cache prefix must not extend beyond compacted KV cells";

  fs::remove(cachePath);
}

TEST_F(MtmdLlmContextTest, ProcessWithSessionCache) {
  if (!hasValidModel()) {
    FAIL() << "Multimodal model or projection file not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt prompt1;
  prompt1.input = R"([{"role": "user", "content": "Hello"}])";
  prompt1.cacheKey = "test_session.bin";
  EXPECT_NO_THROW({
    std::string output1 = model->processPrompt(prompt1);
    EXPECT_GE(output1.length(), 0);
    auto stats1 = model->runtimeStats();
    EXPECT_GE(stats1.size(), 0);
  });

  LlamaModel::Prompt prompt2;
  prompt2.input = R"([{"role": "user", "content": "Follow up message"}])";
  prompt2.cacheKey = "test_session.bin";
  EXPECT_NO_THROW({
    std::string output2 = model->processPrompt(prompt2);
    EXPECT_GE(output2.length(), 0);
    auto stats2 = model->runtimeStats();
    EXPECT_GE(stats2.size(), 0);
  });
}

/// `llama_state_seq_load_file` restores the sequence's KV before `loadCache`
/// validates it. A throw after the restore must roll those cells back: the
/// scheduler installs its per-slot cleanup guard only once `loadCache` returns,
/// so an unguarded throw strands orphan KV on the slot. Mirrors the text path
/// (`TextLlmContext::loadCache`) and `CacheManager::loadCache`.
TEST_F(MtmdLlmContextTest, LoadCacheRollsBackRestoredKvOnPostRestoreFailure) {
  if (!hasValidModel()) {
    FAIL() << "Multimodal model or projection file not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  auto* base = LlamaModelTestPeer::llmContext(*model);
  ASSERT_NE(base, nullptr);
  auto* ctx = dynamic_cast<MtmdLlmContext*>(base);
  ASSERT_NE(ctx, nullptr) << "single-prompt context for a VLM must be MTMD";
  auto* lctx = model->getContext();
  ASSERT_NE(lctx, nullptr);
  const llama_seq_id seqId = ctx->getSeqId();

  // Prefill a prompt so the sequence holds real KV cells we can persist.
  LlamaModel::Prompt prompt;
  prompt.input = R"([{"role": "user", "content": "Hello"}])";
  prompt.prefill = true;
  ASSERT_NO_THROW(model->processPrompt(prompt));
  ASSERT_GT(ctx->getNPast(), 0);

  // Persist the genuine KV but with a doctored NPast that exceeds the
  // context window. All four metadata fields are present so the
  // completeness gate passes and execution reaches the NPast bounds check.
  const llama_token overflowNPast =
      static_cast<llama_token>(llama_n_ctx(lctx)) + 1;
  const llama_token plausible = static_cast<llama_token>(ctx->getNPast());
  const llama_token sessionTokens[SESSION_METADATA_FIELD_COUNT] = {
      overflowNPast, plausible, plausible, plausible};

  const fs::path cachePath =
      fs::temp_directory_path() / "qvac-mtmd-loadcache-rollback.bin";
  fs::remove(cachePath);
  const auto savedBytes = llama_state_seq_save_file(
      lctx,
      cachePath.string().c_str(),
      seqId,
      sessionTokens,
      SESSION_METADATA_FIELD_COUNT);
  ASSERT_GT(savedBytes, 0u);

  // Clear the sequence so restoration is observable from a clean baseline.
  ctx->resetState(true);
  auto* mem = llama_get_memory(lctx);
  ASSERT_NE(mem, nullptr);
  ASSERT_EQ(llama_memory_seq_token_count(mem, seqId), 0u)
      << "precondition: sequence KV must be empty before the failing load";

  bool threw = false;
  try {
    (void)ctx->loadCache(cachePath.string(), 0);
  } catch (const qvac_errors::StatusError&) {
    threw = true;
  }
  EXPECT_TRUE(threw)
      << "loadCache must reject a cache whose NPast exceeds the context size";

  const uint32_t leakedCells = llama_memory_seq_token_count(mem, seqId);
  SCOPED_TRACE(
      "sequence KV cells after failed load: " + std::to_string(leakedCells));
  EXPECT_EQ(leakedCells, 0u)
      << "loadCache restored KV then threw without rolling it back: the slot "
         "leaks orphan KV cells. A ScopeGuard must clear the sequence on any "
         "post-restore validation failure.";

  fs::remove(cachePath);
}

TEST_F(MtmdLlmContextTest, LoadCacheRejectsRestoredMemoryMetadataMismatch) {
  if (!hasValidModel()) {
    FAIL() << "Multimodal model or projection file not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  auto* base = LlamaModelTestPeer::llmContext(*model);
  ASSERT_NE(base, nullptr);
  auto* ctx = dynamic_cast<MtmdLlmContext*>(base);
  ASSERT_NE(ctx, nullptr) << "single-prompt context for a VLM must be MTMD";
  auto* lctx = model->getContext();
  ASSERT_NE(lctx, nullptr);
  const llama_seq_id seqId = ctx->getSeqId();

  LlamaModel::Prompt prompt;
  prompt.input = R"([{"role": "user", "content": "Hello"}])";
  prompt.prefill = true;
  ASSERT_NO_THROW(model->processPrompt(prompt));
  ASSERT_GT(ctx->getNPast(), 0);
  ASSERT_GT(ctx->getCacheTokens(), 0);

  const llama_token nPast = static_cast<llama_token>(ctx->getNPast());
  const llama_token firstMsgTokens =
      static_cast<llama_token>(ctx->getFirstMsgTokens());
  const llama_token cacheTokens =
      static_cast<llama_token>(ctx->getCacheTokens());
  const llama_token firstMsgCacheTokens =
      static_cast<llama_token>(ctx->getFirstMsgCacheTokens());

  const fs::path nPastMismatchPath =
      fs::temp_directory_path() / "qvac-mtmd-loadcache-npast-mismatch.bin";
  const fs::path cacheTokensMismatchPath =
      fs::temp_directory_path() /
      "qvac-mtmd-loadcache-cachetokens-mismatch.bin";
  fs::remove(nPastMismatchPath);
  fs::remove(cacheTokensMismatchPath);

  const llama_token nPastMismatch[SESSION_METADATA_FIELD_COUNT] = {
      static_cast<llama_token>(nPast + 1),
      firstMsgTokens,
      cacheTokens,
      firstMsgCacheTokens};
  ASSERT_GT(
      llama_state_seq_save_file(
          lctx,
          nPastMismatchPath.string().c_str(),
          seqId,
          nPastMismatch,
          SESSION_METADATA_FIELD_COUNT),
      0u);

  const llama_token cacheTokensMismatch[SESSION_METADATA_FIELD_COUNT] = {
      nPast,
      firstMsgTokens,
      static_cast<llama_token>(cacheTokens + 1),
      firstMsgCacheTokens};
  ASSERT_GT(
      llama_state_seq_save_file(
          lctx,
          cacheTokensMismatchPath.string().c_str(),
          seqId,
          cacheTokensMismatch,
          SESSION_METADATA_FIELD_COUNT),
      0u);

  ctx->resetState(true);
  auto* mem = llama_get_memory(lctx);
  ASSERT_NE(mem, nullptr);
  ASSERT_EQ(llama_memory_seq_token_count(mem, seqId), 0u);

  EXPECT_THROW(
      { (void)ctx->loadCache(nPastMismatchPath.string(), 0); },
      qvac_errors::StatusError)
      << "loadCache must reject metadata nPast that differs from live KV";
  EXPECT_EQ(llama_memory_seq_token_count(mem, seqId), 0u)
      << "rejected nPast mismatch must clear restored KV cells";
  EXPECT_EQ(ctx->getNPast(), 0);
  EXPECT_EQ(ctx->getCacheTokens(), 0);

  EXPECT_THROW(
      { (void)ctx->loadCache(cacheTokensMismatchPath.string(), 0); },
      qvac_errors::StatusError)
      << "loadCache must reject metadata cacheTokens that differs from live KV";
  EXPECT_EQ(llama_memory_seq_token_count(mem, seqId), 0u)
      << "rejected cacheTokens mismatch must clear restored KV cells";
  EXPECT_EQ(ctx->getNPast(), 0);
  EXPECT_EQ(ctx->getCacheTokens(), 0);

  fs::remove(nPastMismatchPath);
  fs::remove(cacheTokensMismatchPath);
}

TEST_F(MtmdLlmContextTest, InvalidMedia) {
  if (!hasValidModel()) {
    FAIL() << "Multimodal model or projection file not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  std::vector<uint8_t> invalidData = {0x00, 0x01, 0x02};
  LlamaModel::Prompt prompt;
  prompt.input = R"([{"role": "user", "content": "What is this?"}])";
  prompt.media.push_back(std::move(invalidData));
  EXPECT_THROW({ model->processPrompt(prompt); }, qvac_errors::StatusError);
}

TEST_F(MtmdLlmContextTest, NonexistentFile) {
  if (!hasValidModel()) {
    FAIL() << "Multimodal model or projection file not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt prompt;
  prompt.input =
      R"([{"type": "media", "content": "nonexistent_image.jpg"}, {"role": "user", "content": "What is this?"}])";
  EXPECT_THROW({ model->processPrompt(prompt); }, qvac_errors::StatusError);
}

/// A batch prompt may carry media as a string file path (not just inline
/// `Uint8Array` bytes). The per-slot MTMD driver must load that file itself,
/// exactly as the single-prompt path does. With the bug the path is loaded
/// into the shared context instead, so the per-slot driver sees a media
/// marker with no bitmap and the batch throws.
TEST_F(MtmdLlmContextTest, BatchLoadsPathModeMediaPerSlot) {
  if (!hasValidModel()) {
    FAIL() << "Multimodal model or projection file not found";
  }

  // Resolve media/ whether the test binary runs from the package root or from
  // build/test/unit (mirrors BaseTestModelPath's two-location model lookup).
  fs::path imagePath = "../../../media/elephant.jpg";
  if (!fs::exists(imagePath)) {
    imagePath = "media/elephant.jpg";
  }
  ASSERT_TRUE(fs::exists(imagePath))
      << "test image missing: " << fs::absolute(imagePath).string();
  imagePath = fs::absolute(imagePath);

  auto cfg = config_files;
  cfg["parallel"] = "2";
  cfg["n_predict"] = "16";
  std::string modelPath = test_model_path;
  std::string projectionPath = test_projection_path;
  auto model = std::make_unique<LlamaModel>(
      std::move(modelPath), std::move(projectionPath), std::move(cfg));
  model->waitForLoadInitialization();
  ASSERT_TRUE(model->isLoaded());

  LlamaModel::Prompt prompt;
  prompt.input =
      std::string(R"([{"role":"user","type":"media","content":")") +
      imagePath.generic_string() +
      R"("},{"role":"user","content":"What is in this image? One word."}])";

  std::vector<std::string> outputs;
  ASSERT_NO_THROW({
    outputs =
        model->processPromptBatch(std::vector<LlamaModel::Prompt>{prompt});
  });
  ASSERT_EQ(outputs.size(), 1u);
  EXPECT_FALSE(outputs[0].empty())
      << "batch path-mode media produced no output: the per-slot driver "
         "never loaded the image file";
}

/// A batch prompt may interleave a string-path media item and an inline
/// `Uint8Array` byte media item. The per-slot MTMD driver loads media via the
/// ordered plan, so each bitmap binds to its own marker in prompt-marker order
/// rather than bytes-then-paths. Both images decode cleanly on their own, so
/// the mixed-mode prompt is accepted and produces output. With the bug
/// `preparePrefill` rejected any byte+path mix instead of preserving order.
TEST_F(MtmdLlmContextTest, BatchPreservesMixedByteAndPathMediaOrder) {
  if (!hasValidModel()) {
    FAIL() << "Multimodal model or projection file not found";
  }

  // Resolve media/ whether the test binary runs from the package root or from
  // build/test/unit (mirrors BaseTestModelPath's two-location model lookup).
  fs::path mediaDir = "../../../media";
  if (!fs::exists(mediaDir)) {
    mediaDir = "media";
  }
  const fs::path pathImage = fs::absolute(mediaDir / "elephant.jpg");
  const fs::path byteImage = fs::absolute(mediaDir / "fruitPlate.png");
  ASSERT_TRUE(fs::exists(pathImage)) << pathImage.string();
  ASSERT_TRUE(fs::exists(byteImage)) << byteImage.string();

  std::ifstream byteStream(byteImage, std::ios::binary);
  ASSERT_TRUE(byteStream) << "failed to open " << byteImage.string();
  const std::vector<uint8_t> byteData(
      (std::istreambuf_iterator<char>(byteStream)),
      std::istreambuf_iterator<char>());
  ASSERT_FALSE(byteData.empty());

  auto cfg = config_files;
  cfg["parallel"] = "2";
  cfg["n_predict"] = "16";
  std::string modelPath = test_model_path;
  std::string projectionPath = test_projection_path;
  auto model = std::make_unique<LlamaModel>(
      std::move(modelPath), std::move(projectionPath), std::move(cfg));
  model->waitForLoadInitialization();
  ASSERT_TRUE(model->isLoaded());

  // Path media item first, then a byte placeholder (empty content marks the
  // hoisted `Uint8Array`), so the marker order is path, byte. The driver must
  // load the path bitmap before the byte bitmap to match that order.
  LlamaModel::Prompt prompt;
  prompt.input =
      std::string(R"([{"role":"user","type":"media","content":")") +
      pathImage.generic_string() +
      R"("},{"role":"user","type":"media","content":""},)"
      R"({"role":"user","content":"What is in these images? One word."}])";
  prompt.media.push_back(byteData);

  std::vector<std::string> outputs;
  ASSERT_NO_THROW({
    outputs =
        model->processPromptBatch(std::vector<LlamaModel::Prompt>{prompt});
  });
  ASSERT_EQ(outputs.size(), 1u);
  EXPECT_FALSE(outputs[0].empty())
      << "batch mixed byte+path media produced no output: the per-slot driver "
         "never bound both bitmaps in prompt-marker order";
}

TEST_F(MtmdLlmContextTest, ProcessWithTools) {
  if (!hasValidModel()) {
    FAIL() << "Multimodal model or projection file not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt prompt;
  prompt.input = R"([
    {"role": "user", "content": "What is the weather in Tokyo?"},
    {
      "type": "function",
      "name": "getWeather",
      "description": "Get weather forecast for a city",
      "parameters": {
        "type": "object",
        "properties": {
          "city": {"type": "string", "description": "City name"},
          "date": {"type": "string", "description": "Date in YYYY-MM-DD"}
        },
        "required": ["city", "date"]
      }
    }
  ])";

  EXPECT_NO_THROW({
    std::string output = model->processPrompt(prompt);
    EXPECT_GE(output.length(), 0);
    auto stats = model->runtimeStats();
    EXPECT_GE(stats.size(), 0);
  });
}

TEST_F(MtmdLlmContextTest, ProcessWithMultipleTools) {
  if (!hasValidModel()) {
    FAIL() << "Multimodal model or projection file not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  LlamaModel::Prompt prompt;
  prompt.input = R"([
    {"role": "user", "content": "Search for products and add to cart"},
    {
      "type": "function",
      "name": "searchProducts",
      "description": "Search products",
      "parameters": {
        "type": "object",
        "properties": {
          "query": {"type": "string", "description": "Search query"}
        },
        "required": ["query"]
      }
    },
    {
      "type": "function",
      "name": "addToCart",
      "description": "Add items to cart",
      "parameters": {
        "type": "object",
        "properties": {
          "items": {
            "type": "array",
            "items": {"type": "string"}
          }
        },
        "required": ["items"]
      }
    }
  ])";

  EXPECT_NO_THROW({
    std::string output = model->processPrompt(prompt);
    EXPECT_GE(output.length(), 0);
    auto stats = model->runtimeStats();
    EXPECT_GE(stats.size(), 0);
  });
}

/// `loadCache` may only restore a multimodal session when the GGSQ header
/// carried all four `SessionMetadataField` values. The old gate accepted any
/// `tokenCount > 1`, so a partial header (2 or 3 fields) was restored with
/// `cacheTokens`/`firstMsgCacheTokens` defaulted to zero — which diverges from
/// `nPast` under M-RoPE and corrupts later cap checks. An over-long layout
/// (`> 4`) is equally unexpected. Only an exact four-field header is complete.
TEST(MtmdSessionMetadataGate, AcceptsOnlyTheFullFourFieldContract) {
  EXPECT_FALSE(mtmdSessionMetadataIsComplete(0));
  EXPECT_FALSE(mtmdSessionMetadataIsComplete(1));
  EXPECT_FALSE(mtmdSessionMetadataIsComplete(2));
  EXPECT_FALSE(mtmdSessionMetadataIsComplete(3));
  EXPECT_TRUE(mtmdSessionMetadataIsComplete(SESSION_METADATA_FIELD_COUNT));
  EXPECT_FALSE(mtmdSessionMetadataIsComplete(SESSION_METADATA_FIELD_COUNT + 1));
}

TEST_F(MtmdLlmContextTest, RejectMediaMarkerWithoutBuffer) {
  if (!hasValidModel()) {
    FAIL() << "Multimodal model or projection file not found";
  }

  auto model = createModel();
  if (!model) {
    FAIL() << "Model failed to load";
  }

  // Prompt with an empty media marker (no path) but no buffer provided.
  // The marker will be recorded by formatPrompt as MediaSource::ByteBuffer
  // but prompt.media is empty, so loadMedia should fail with a validation
  // error.
  LlamaModel::Prompt prompt;
  prompt.input =
      R"([{"type": "media", "content": ""}, {"role": "user", "content": "What is this?"}])";
  // prompt.media is empty - missing the buffer that the marker expects

  EXPECT_THROW({ model->processPrompt(prompt); }, qvac_errors::StatusError);
}

/// Regression for review comment #3451899281. On the continuous-batching path
/// the scheduler decodes generated tokens itself and reconciles the driver
/// only through syncPosition(); cacheTokens is otherwise advanced solely by
/// prefill/media eval. Each generated token is text and consumes exactly one
/// KV cell, so syncPosition() must advance physical KV-cell usage in lockstep
/// with the logical position. If it advances only the position, the per-slot
/// KV-cell cap in onLogitsReady() keeps comparing against the frozen prefill
/// count, and an M-RoPE slot (cacheTokens > pos) can generate past its budget.
TEST_F(MtmdLlmContextTest, SyncPositionAdvancesKvCellsForGeneratedTokens) {
  if (!hasValidModel()) {
    FAIL() << "Multimodal model or projection file not found";
  }
  auto model = createModel();
  ASSERT_NE(model, nullptr) << "Model failed to load";

  LlmContext* ctx = LlamaModelTestPeer::llmContext(*model);
  ASSERT_NE(ctx, nullptr);
  auto* driver = dynamic_cast<SequenceDriver*>(ctx);
  ASSERT_NE(driver, nullptr)
      << "MTMD context must expose the SequenceDriver interface";

  // Seed an M-RoPE prefill state where physical KV cells exceed logical
  // positions, as media does (cacheTokens > pos).
  constexpr llama_pos prefillPos = 10;
  constexpr llama_pos prefillCells = 20;
  ctx->setNPast(prefillPos);
  ctx->setCacheTokens(prefillCells);
  ASSERT_EQ(driver->getKvCellsUsed(), prefillCells);

  // The scheduler feeds three generated text tokens, advancing the logical
  // position 10 -> 13. Generated text is one KV cell per position.
  constexpr llama_pos generated = 3;
  driver->syncPosition(prefillPos + generated);

  EXPECT_EQ(ctx->getNPast(), prefillPos + generated);
  EXPECT_EQ(driver->getKvCellsUsed(), prefillCells + generated)
      << "syncPosition advanced the logical position but not physical KV-cell "
         "usage; onLogitsReady's per-slot KV-cell cap would be checked against "
         "a frozen prefill count";
}
