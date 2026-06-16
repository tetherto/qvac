// Regression test: KV cache leak when batch admission fails after loadCache.
//
// Bug: ContinuousBatchScheduler::submitLocked calls driver->loadCache() before
// the prompt-size cap check. If the cap check throws, driver (unique_ptr) is
// destroyed without llama_memory_seq_rm, orphaning KV rows for seqId.
// slots_[seqId] was never emplaced, so clearLocked/finalizeFinishedSequences
// skip it. The KV rows persist until scheduler teardown.
//
// Test strategy:
//   1. Seed a cache file (prefill+save) -- seqId=0 gets ~20 KV tokens.
//   2. Submit with that cache key + oversized prompt:
//      nPast(~20) + newTokens(~115) > perSeqMaxTokens(128) -> throw after
//      loadCache, before slots_[seqId].emplace.
//   3. Assert llama_memory_seq_pos_max(mem, 0) == -1 (no leaked KV).
//      With the bug: returns the cached nPast > 0.
//   4. Verify a subsequent valid batch still works (slot is reusable).

#include <chrono>
#include <filesystem>
#include <string>
#include <unordered_map>
#include <vector>

#include <gtest/gtest.h>
#include <inference-addon-cpp/Errors.hpp>
#include <llama.h>

#include "model-interface/LlamaModel.hpp"
#include "test_common.hpp"

namespace {

namespace fs = std::filesystem;

std::string uniqueKvLeakTestId() {
  return std::to_string(
      std::chrono::high_resolution_clock::now().time_since_epoch().count());
}

static LlamaModel::Prompt makeKvLeakPrompt(const std::string& userText) {
  LlamaModel::Prompt p;
  p.input = std::string(R"([{"role":"user","content":")") + userText + R"("}])";
  return p;
}

/// Returns ~targetTokens BPE tokens worth of text (rough: 4 chars/token).
std::string makeTokenFillerText(size_t targetTokens) {
  const std::string unit = "alpha beta gamma delta epsilon zeta eta theta ";
  std::string result;
  result.reserve(targetTokens * 6);
  while (result.size() < targetTokens * 4) {
    result += unit;
  }
  return result;
}

class KvLeakOnAdmitFailureTest : public ::testing::Test {
protected:
  void SetUp() override {
    using MP = test_common::TestModelPath;
    model_ =
        MP("Llama-3.2-1B-Instruct-Q4_0.gguf",
           nullptr,
           MP::OnMissing::Skip,
           "https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF");

    // ctx=512, parallel=4 -> perSeqMaxTokens = 512/4 = 128.
    config_["device"] = test_common::getTestDevice();
    config_["ctx_size"] = "512";
    config_["gpu_layers"] = test_common::getTestGpuLayers();
    config_["parallel"] = "4";
    config_["batch_size"] = "256";
    config_["n_predict"] = "4";
    config_["temp"] = "0";
    config_["backendsDir"] = test_common::getTestBackendsDir().string();
  }

  std::unique_ptr<LlamaModel> loadTestModel() {
    std::string modelPath = model_.path;
    std::string projectionPath{};
    std::unordered_map<std::string, std::string> config(config_);
    auto m = std::make_unique<LlamaModel>(
        std::move(modelPath), std::move(projectionPath), std::move(config));
    m->waitForLoadInitialization();
    return m;
  }

  std::unordered_map<std::string, std::string> config_;
  test_common::TestModelPath model_;
};

} // namespace

/// KV rows loaded by loadCache must be cleaned up when admission fails
/// after loadCache but before slots_[seqId].emplace. With the bug, the
/// rows are orphaned; with the fix they are removed by either the reordering
/// (loadCache moves after validatePromptPolicy, before cap-check) combined
/// with a RAII scope-exit guard that calls llama_memory_seq_rm on unwind.
TEST_F(KvLeakOnAdmitFailureTest, KvRowsCleanedAfterAdmitFailurePostCache) {
  REQUIRE_MODEL(model_);
  auto model = loadTestModel();

  const fs::path cachePath = fs::temp_directory_path() /
                             ("kv-leak-test-" + uniqueKvLeakTestId() + ".bin");

  // Stage 1: seed the cache file so loadCache will populate real KV rows.
  auto seedPrompt = makeKvLeakPrompt("Remember: the sky is blue.");
  seedPrompt.prefill = true;
  seedPrompt.cacheKey = cachePath.string();
  seedPrompt.saveCacheToDisk = true;

  auto seedOutputs = model->processPromptBatch(
      std::vector<LlamaModel::Prompt>{std::move(seedPrompt)});
  ASSERT_EQ(seedOutputs.size(), 1u);
  ASSERT_TRUE(fs::exists(cachePath)) << "cache file not created";
  ASSERT_GT(fs::file_size(cachePath), 0u);

  // Stage 2: submit with cache key + oversized prompt.
  // perSeqMaxTokens varies by model ctx_size (model GGUF may override config).
  // Use 2000 tokens to reliably exceed any reasonable per-seq cap.
  // Throws AFTER loadCache has populated KV rows.
  auto oversizedPrompt = makeKvLeakPrompt(makeTokenFillerText(2000));
  oversizedPrompt.cacheKey = cachePath.string();

  bool threw = false;
  std::string errCode;
  std::string errMsg;
  try {
    model->processPromptBatch(
        std::vector<LlamaModel::Prompt>{std::move(oversizedPrompt)});
  } catch (const qvac_errors::StatusError& e) {
    threw = true;
    errCode = e.codeString();
    errMsg = e.what();
    EXPECT_TRUE(
        errCode.find("InvalidArgument") != std::string::npos ||
        errCode.find("ContextOverflow") != std::string::npos)
        << "unexpected error: " << errCode;
  }

  if (!threw) {
    fs::remove(cachePath);
    std::cout << "DEBUG: Prompt of length " << makeTokenFillerText(2000).size()
              << " did not throw!" << std::endl;
    GTEST_SKIP() << "oversized prompt did not exceed perSeqMaxTokens cap -- "
                    "increase token filler or reduce ctx_size/parallel ratio";
  } else {
    std::cout << "DEBUG: Threw expected exception: " << errCode << " / "
              << errMsg << std::endl;
  }

  // Stage 3: assert KV memory for seqId=0 is clean after the failed admit.
  // llama_memory_seq_pos_max returns -1 when no data exists for a sequence.
  // With the bug: > 0 (loadCache data leaked).
  // With the fix: == -1 (RAII guard called llama_memory_seq_rm on unwind).
  llama_context* lctx = model->getContext();
  ASSERT_NE(lctx, nullptr);
  llama_memory_t mem = llama_get_memory(lctx);
  ASSERT_NE(mem, nullptr);

  const llama_pos leakedPosMax = llama_memory_seq_pos_max(mem, /*seqId=*/0);
  EXPECT_EQ(leakedPosMax, -1)
      << "KV CACHE LEAK: after failed batch admit (throw after loadCache), "
         "seqId=0 has orphaned KV data at pos_max="
      << leakedPosMax
      << ". "
         "llama_memory_seq_rm was never called. Fix: move loadCache after "
         "validatePromptPolicy and add RAII guard to clean up on throw.";

  // Stage 4: verify the slot is cleanly reusable.
  auto validOutputs = model->processPromptBatch(
      std::vector<LlamaModel::Prompt>{makeKvLeakPrompt("Say hi.")});
  ASSERT_EQ(validOutputs.size(), 1u);
  EXPECT_FALSE(validOutputs[0].empty())
      << "slot not reusable after leaked-KV admission failure";

  fs::remove(cachePath);
}
