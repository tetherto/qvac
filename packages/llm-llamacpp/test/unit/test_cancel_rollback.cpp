#include <atomic>
#include <chrono>
#include <exception>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <memory>
#include <optional>
#include <string>
#include <thread>
#include <unordered_map>
#include <utility>
#include <variant>
#include <vector>

#include <common/chat.h>
#include <gtest/gtest.h>
#include <inference-addon-cpp/Errors.hpp>
#include <llama.h>

#include "model-interface/ContextSlider.hpp"
#include "model-interface/LlamaModel.hpp"
#include "model-interface/MtmdLlmContext.hpp"
#include "model-interface/ReasoningBlockCompactor.hpp"
#include "model-interface/TextLlmContext.hpp"
#include "model-interface/ToolsCompactController.hpp"
#include "test_common.hpp"
#include "test_internal_peers.hpp"
#include "utils/RecurrentStateSnapshot.hpp"

// Tests for the cancel-rollback paths introduced alongside
// `remove_thinking_from_context` for hybrid SSM models. Two layers of
// coverage:
//   1. Snapshot / restore primitive against a real `llama_context`
//      (hybrid + pure-attention). Pins the foundational behaviour that
//      `llama_state_seq_save_file` / `load_file` rewind both the
//      attention KV and the recurrent state.
//   2. Cancel-rollback wiring on `TextLlmContext` and `MtmdLlmContext`
//      end-to-end through their public entrypoints (`evalMessageWithTools`,
//      `onCancel`, `generateResponse`, `stop`).
//
// Hybrid-specific tests skip when the Qwen3.5 fixture is not present.
// Pure-attention tests use the Qwen3-0.6B fixture (always downloaded in
// the CI manifest). Multimodal tests additionally require the Qwen3.5
// projection file.

namespace fs = std::filesystem;

using qvac_lib_inference_addon_llama::utils::RecurrentStateSnapshot;
using qvac_lib_inference_addon_llama::utils::restoreRecurrentState;
using qvac_lib_inference_addon_llama::utils::snapshotRecurrentState;

namespace {

llama_pos seqPosMax(LlamaModel& model, llama_seq_id seqId = 0) {
  auto* mem = llama_get_memory(model.getContext());
  if (mem == nullptr) {
    return -1;
  }
  return llama_memory_seq_pos_max(mem, seqId);
}

common_chat_msg makeMsg(const std::string& role, const std::string& content) {
  common_chat_msg msg;
  msg.role = role;
  msg.content = content;
  return msg;
}

std::string qwen35HybridModelPath() {
  return test_common::BaseTestModelPath::get("Qwen3.5-0.8B-Q8_0.gguf");
}

std::string qwen3PureAttentionModelPath() {
  return test_common::BaseTestModelPath::get("Qwen3-0.6B-Q8_0.gguf");
}

std::string qwen35MmprojPath() {
  return test_common::BaseTestModelPath::get("mmproj-Qwen3.5-0.8B-F16.gguf");
}

bool modelFileExists(const std::string& path) { return fs::exists(path); }

std::unique_ptr<LlamaModel> loadTextModel(const std::string& modelPath) {
  if (!modelFileExists(modelPath)) {
    return nullptr;
  }
  std::unordered_map<std::string, std::string> config;
  config["device"] = test_common::getTestDevice();
  config["ctx_size"] = "4096";
  config["gpu_layers"] = test_common::getTestGpuLayers();
  config["n_predict"] = "8";
  config["backendsDir"] = test_common::getTestBackendsDir().string();

  std::string path = modelPath;
  std::string projection;
  auto model = std::make_unique<LlamaModel>(
      std::move(path), std::move(projection), std::move(config));
  model->waitForLoadInitialization();
  if (!model->isLoaded()) {
    return nullptr;
  }
  return model;
}

std::unique_ptr<LlamaModel>
loadMtmdModel(const std::string& modelPath, const std::string& projectionPath) {
  if (!modelFileExists(modelPath) || !modelFileExists(projectionPath)) {
    return nullptr;
  }
  std::unordered_map<std::string, std::string> config;
  config["device"] = test_common::getTestDevice();
  config["ctx_size"] = "4096";
  config["gpu_layers"] = test_common::getTestGpuLayers();
  config["n_predict"] = "8";
  config["backendsDir"] = test_common::getTestBackendsDir().string();

  std::string mp = modelPath;
  std::string pp = projectionPath;
  auto model = std::make_unique<LlamaModel>(
      std::move(mp), std::move(pp), std::move(config));
  model->waitForLoadInitialization();
  if (!model->isLoaded()) {
    return nullptr;
  }
  return model;
}

LlmModelContext makeShared(LlamaModel& model) {
  return LlmModelContext{
      .model = model.getModel(),
      .lctx = model.getContext(),
      .vocab = llama_model_get_vocab(model.getModel())};
}

// Seeds a non-zero cache state on the model, leaving it ready for follow-up
// inspection. Uses prefill mode so no generation runs (faster, deterministic).
void primeWithPrefill(LlamaModel& model, const std::string& userText) {
  LlamaModel::Prompt prompt;
  prompt.input = R"([{"role":"user","content":")" + userText + R"("}])";
  prompt.prefill = true;
  model.processPrompt(prompt);
}

LlamaModel::Prompt makeMtmdRecoveryPrompt() {
  LlamaModel::Prompt recovery;
  recovery.input =
      R"([{"role":"user","content":"Answer with exactly one word: ok"}])";
  recovery.generationParams.remove_thinking_from_context = false;
  recovery.generationParams.reasoning_budget = 0;
  recovery.generationParams.n_predict = 32;
  return recovery;
}

// Returns the canonical small test image path used elsewhere in the
// unit test suite. Mirrors `multimodalTestImagePath()` from
// `test_mtmd_llm_context.cpp`; duplicated here to keep this file
// self-contained.
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

std::vector<uint8_t> readBinaryFile(const fs::path& path) {
  std::ifstream stream(path, std::ios::binary);
  return {
      std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>()};
}

// Look up a named int64 entry in the runtime stats vector. Returns
// std::nullopt when the key is absent so callers can distinguish
// "missing key" from "key present, value is zero".
std::optional<int64_t> statInt(LlamaModel& model, const std::string& key) {
  auto stats = model.runtimeStats();
  for (const auto& entry : stats) {
    if (entry.first != key) {
      continue;
    }
    if (std::holds_alternative<int64_t>(entry.second)) {
      return std::get<int64_t>(entry.second);
    }
    return static_cast<int64_t>(std::get<double>(entry.second));
  }
  return std::nullopt;
}

} // namespace

// ============================================================================
// Layer 1: snapshot / restore primitive against a real llama_context
// ============================================================================

class CancelRollbackPrimitiveTest : public ::testing::Test {};

// Foundation: on a hybrid SSM model, snapshotting the sequence state and
// then restoring it after a `model->reset()` must return the cache to its
// pre-reset position. This is the mechanism every cancel-rollback path
// relies on.
TEST_F(CancelRollbackPrimitiveTest, SnapshotRestoreRoundtripQwen35Hybrid) {
  auto model = loadTextModel(qwen35HybridModelPath());
  if (!model) {
    GTEST_SKIP() << "Qwen3.5 hybrid model not found";
  }

  primeWithPrefill(*model, "Hello, this is the seed prompt.");
  const llama_pos posBefore = seqPosMax(*model);
  ASSERT_GT(posBefore, 0) << "prefill must have advanced the cache";

  RecurrentStateSnapshot snap;
  ASSERT_TRUE(snapshotRecurrentState(
      model->getContext(), /*seqId=*/0, posBefore + 1, snap));
  ASSERT_FALSE(snap.empty())
      << "hybrid model snapshot must be non-empty (recurrent state present)";
  EXPECT_EQ(snap.nPast, posBefore + 1);

  model->reset();
  ASSERT_EQ(seqPosMax(*model), -1)
      << "reset should fully clear the sequence memory";

  ASSERT_TRUE(restoreRecurrentState(model->getContext(), /*seqId=*/0, snap));
  EXPECT_EQ(seqPosMax(*model), posBefore)
      << "restore must return the cache to the snapshotted position";
}

// Same roundtrip for a pure-attention model. The snapshot+restore primitive
// is architecture-agnostic — it works for attention-only memories too.
TEST_F(
    CancelRollbackPrimitiveTest, SnapshotRestoreRoundtripQwen3PureAttention) {
  auto model = loadTextModel(qwen3PureAttentionModelPath());
  if (!model) {
    GTEST_SKIP() << "Qwen3-0.6B pure-attention model not found";
  }

  primeWithPrefill(*model, "Hello, this is the seed prompt.");
  const llama_pos posBefore = seqPosMax(*model);
  ASSERT_GT(posBefore, 0);

  RecurrentStateSnapshot snap;
  ASSERT_TRUE(snapshotRecurrentState(
      model->getContext(), /*seqId=*/0, posBefore + 1, snap));
  ASSERT_FALSE(snap.empty());

  model->reset();
  ASSERT_EQ(seqPosMax(*model), -1);

  ASSERT_TRUE(restoreRecurrentState(model->getContext(), /*seqId=*/0, snap));
  EXPECT_EQ(seqPosMax(*model), posBefore);
}

// Snapshot taken before any tokens have been decoded: no temp file is
// needed because there is no committed sequence state yet, but restore
// must still be idempotent against a freshly reset context.
TEST_F(CancelRollbackPrimitiveTest, SnapshotEmptySequenceHybridIsRestorable) {
  auto model = loadTextModel(qwen35HybridModelPath());
  if (!model) {
    GTEST_SKIP() << "Qwen3.5 hybrid model not found";
  }

  RecurrentStateSnapshot snap;
  ASSERT_TRUE(snapshotRecurrentState(
      model->getContext(), /*seqId=*/0, /*nPastAt=*/0, snap));
  EXPECT_EQ(snap.nPast, 0);

  // Restoring an empty-sequence snapshot must succeed and leave the
  // cache empty.
  ASSERT_TRUE(restoreRecurrentState(model->getContext(), /*seqId=*/0, snap));
  EXPECT_EQ(seqPosMax(*model), -1);
}

// Mid-decode snapshot + restore: prime the cache, snapshot, prime again
// (advancing the cache further via a reset+second prefill), then restore.
// Verifies that the second prefill's content is fully wiped by the
// restore.
TEST_F(CancelRollbackPrimitiveTest, RestoreDropsLaterContentOnHybrid) {
  auto model = loadTextModel(qwen35HybridModelPath());
  if (!model) {
    GTEST_SKIP() << "Qwen3.5 hybrid model not found";
  }

  primeWithPrefill(*model, "Short");
  const llama_pos posAfterShort = seqPosMax(*model);
  ASSERT_GT(posAfterShort, 0);

  RecurrentStateSnapshot snap;
  ASSERT_TRUE(snapshotRecurrentState(
      model->getContext(), /*seqId=*/0, posAfterShort + 1, snap));

  // Run a longer prefill that resets and grows the cache beyond the
  // snapshotted position.
  primeWithPrefill(
      *model,
      "A much longer second prompt that should grow the cache well past "
      "the original snapshot position so the restore step has something "
      "meaningful to drop.");
  const llama_pos posAfterLong = seqPosMax(*model);
  ASSERT_GT(posAfterLong, posAfterShort)
      << "second prefill should have grown the cache beyond the snapshot";

  ASSERT_TRUE(restoreRecurrentState(model->getContext(), /*seqId=*/0, snap));
  EXPECT_EQ(seqPosMax(*model), posAfterShort)
      << "restore must drop the second prefill's tail and return to the "
         "snapshotted position";
}

// ============================================================================
// Layer 2a: TextLlmContext cancel paths
// ============================================================================

class TextLlmContextCancelTest : public ::testing::Test {};

// Cancel signalled before `evalMessageWithTools` runs must:
//   * return false (inference did not complete),
//   * leave nPast at 0 (the snapshot at function entry is restored on the
//     hybrid path; on the pure-attention path `removeLastNTokens(0)` is a
//     no-op).
TEST_F(TextLlmContextCancelTest, PrefillCancelAtEntryReturnsFalseOnHybrid) {
  auto model = loadTextModel(qwen35HybridModelPath());
  if (!model) {
    GTEST_SKIP() << "Qwen3.5 hybrid model not found";
  }

  LlmModelContext shared = makeShared(*model);
  ToolsCompactController tools(std::nullopt);
  common_params params = model->getCommonParams();
  TextLlmContext driver(params, shared, tools, /*seqId=*/0);

  driver.stop();
  std::vector<common_chat_msg> chatMsgs = {makeMsg("user", "Hi")};
  const LlmContext::EvalMessageResult result = driver.evalMessageWithTools(
      chatMsgs, /*tools=*/{}, /*isCacheLoaded=*/false, /*prefill=*/false);

  EXPECT_FALSE(result.ok);
  EXPECT_TRUE(result.cancelled);
  EXPECT_TRUE(result.rollbackOk);
  EXPECT_EQ(driver.getNPast(), 0);
  EXPECT_EQ(seqPosMax(*model), -1)
      << "cancelled prefill must not leave KV cells resident";
}

TEST_F(
    TextLlmContextCancelTest, PrefillCancelAtEntryReturnsFalseOnPureAttention) {
  auto model = loadTextModel(qwen3PureAttentionModelPath());
  if (!model) {
    GTEST_SKIP() << "Qwen3-0.6B pure-attention model not found";
  }

  LlmModelContext shared = makeShared(*model);
  ToolsCompactController tools(std::nullopt);
  common_params params = model->getCommonParams();
  TextLlmContext driver(params, shared, tools, /*seqId=*/0);

  driver.stop();
  std::vector<common_chat_msg> chatMsgs = {makeMsg("user", "Hi")};
  const LlmContext::EvalMessageResult result = driver.evalMessageWithTools(
      chatMsgs, /*tools=*/{}, /*isCacheLoaded=*/false, /*prefill=*/false);

  EXPECT_FALSE(result.ok);
  EXPECT_TRUE(result.cancelled);
  EXPECT_TRUE(result.rollbackOk);
  EXPECT_EQ(driver.getNPast(), 0);
  EXPECT_EQ(seqPosMax(*model), -1);
}

// After a cancelled prefill, the same context must be usable for the next
// inference: the stop flag is cleared, and a fresh prefill+generation
// succeeds. This is the regression guard against "cancel poisons the
// context" — the original failure mode without the recurrent rollback fix.
TEST_F(
    TextLlmContextCancelTest,
    PrefillCancelLeavesContextUsableForNextInferenceOnHybrid) {
  auto model = loadTextModel(qwen35HybridModelPath());
  if (!model) {
    GTEST_SKIP() << "Qwen3.5 hybrid model not found";
  }

  // First, cancel via the high-level API.
  LlmModelContext shared = makeShared(*model);
  ToolsCompactController tools(std::nullopt);
  common_params params = model->getCommonParams();
  {
    TextLlmContext driver(params, shared, tools, /*seqId=*/0);
    driver.stop();
    std::vector<common_chat_msg> chatMsgs = {makeMsg("user", "Hi")};
    const LlmContext::EvalMessageResult result = driver.evalMessageWithTools(
        chatMsgs, {}, /*isCacheLoaded=*/false, /*prefill=*/false);
    EXPECT_FALSE(result.ok);
    EXPECT_TRUE(result.cancelled);
    EXPECT_TRUE(result.rollbackOk);
    EXPECT_EQ(driver.getNPast(), 0);
  }

  // Then run a normal prefill on a fresh driver — must succeed.
  TextLlmContext driver2(params, shared, tools, /*seqId=*/0);
  std::vector<common_chat_msg> chatMsgs = {makeMsg("user", "Hi")};
  const LlmContext::EvalMessageResult result = driver2.evalMessageWithTools(
      chatMsgs, {}, /*isCacheLoaded=*/false, /*prefill=*/true);
  EXPECT_TRUE(result.ok);
  EXPECT_FALSE(result.cancelled);
  EXPECT_TRUE(result.rollbackOk);
  EXPECT_GT(driver2.getNPast(), 0)
      << "post-cancel prefill must successfully decode tokens";
}

// `onCancel` on a hybrid driver with `remove_thinking_from_context: true`:
// after prefill (which takes the prefill-entry AND end-of-prefill
// snapshots), calling `onCancel` directly must restore the
// PREFILL-ENTRY snapshot — i.e. roll the cache back to the cursor that
// existed BEFORE this request's prompt was submitted, matching the
// "request never happened" cancel semantics. The end-of-prefill
// snapshot is reserved for normal thinking-block compaction and must
// NOT be used for cancel.
TEST_F(TextLlmContextCancelTest, OnCancelRestoresPreRequestSnapshotOnHybrid) {
  auto model = loadTextModel(qwen35HybridModelPath());
  if (!model) {
    GTEST_SKIP() << "Qwen3.5 hybrid model not found";
  }

  LlmModelContext shared = makeShared(*model);
  ToolsCompactController tools(std::nullopt);
  common_params params = model->getCommonParams();
  TextLlmContext driver(params, shared, tools, /*seqId=*/0);
  driver.setRemoveThinkingFromContext(true);

  // Pre-request cursor before any prompt is submitted. For a freshly
  // constructed driver this is 0; we capture it explicitly so the
  // assertion below documents the invariant rather than the value.
  const llama_pos preRequestNPast = driver.getNPast();

  std::vector<common_chat_msg> chatMsgs = {makeMsg("user", "Hi")};
  const LlmContext::EvalMessageResult prefillResult =
      driver.evalMessageWithTools(
          chatMsgs, {}, /*isCacheLoaded=*/false, /*prefill=*/false);
  ASSERT_TRUE(prefillResult.ok);
  EXPECT_FALSE(prefillResult.cancelled);
  EXPECT_TRUE(prefillResult.rollbackOk);
  const llama_pos posAfterPrefill = driver.getNPast();
  ASSERT_GT(posAfterPrefill, preRequestNPast)
      << "prefill must advance the cursor for the test to be meaningful";

  // Cancel after prefill but before any generation token is sampled.
  // The pre-request checkpoint sits at `preRequestNPast`, so restore
  // must wind the cursor BACK to that cursor — not leave it at the
  // post-prefill position.
  EXPECT_TRUE(driver.onCancel([](const std::string&) {}))
      << "onCancel must report rollback-ok when the recurrent restore succeeds";

  EXPECT_EQ(driver.getNPast(), preRequestNPast)
      << "onCancel on hybrid must restore to the PRE-REQUEST cursor, not "
         "the end-of-prefill cursor — cancel semantics is 'request never "
         "happened'";
  // `seq_pos_max` after a full pre-request restore: either -1 (sequence
  // is now empty) or `preRequestNPast - 1` if there were prior turns.
  // For this fresh driver pre-request was 0, so we expect -1.
  if (preRequestNPast == 0) {
    EXPECT_EQ(seqPosMax(*model), static_cast<llama_pos>(-1))
        << "pre-request restore on a fresh driver must clear the sequence";
  }
}

// Pure-attention `onCancel` must now also roll back to the pre-request
// cursor via `removeLastNTokens` (no recurrent snapshot is taken on
// this path). The previous behavior — chain into `onGenerationFinished`
// which leaves the cancelled prompt in the cache — violated the
// "request never happened" cancel semantics and left an orphaned
// `<think>` opener for templates that force-open the reasoning channel.
TEST_F(
    TextLlmContextCancelTest,
    OnCancelOnPureAttentionRollsBackToPreRequestCursor) {
  auto model = loadTextModel(qwen3PureAttentionModelPath());
  if (!model) {
    GTEST_SKIP() << "Qwen3-0.6B pure-attention model not found";
  }

  LlmModelContext shared = makeShared(*model);
  ToolsCompactController tools(std::nullopt);
  common_params params = model->getCommonParams();
  TextLlmContext driver(params, shared, tools, /*seqId=*/0);
  driver.setRemoveThinkingFromContext(true);

  const llama_pos preRequestNPast = driver.getNPast();

  std::vector<common_chat_msg> chatMsgs = {makeMsg("user", "Hi")};
  const LlmContext::EvalMessageResult prefillResult =
      driver.evalMessageWithTools(
          chatMsgs, {}, /*isCacheLoaded=*/false, /*prefill=*/false);
  ASSERT_TRUE(prefillResult.ok);
  EXPECT_FALSE(prefillResult.cancelled);
  EXPECT_TRUE(prefillResult.rollbackOk);
  ASSERT_GT(driver.getNPast(), preRequestNPast);

  bool rollbackOk = false;
  EXPECT_NO_THROW(rollbackOk = driver.onCancel([](const std::string&) {}));
  EXPECT_TRUE(rollbackOk) << "pure-attention onCancel must report rollback-ok "
                             "(no recurrent restore involved)";

  EXPECT_EQ(driver.getNPast(), preRequestNPast)
      << "onCancel on pure-attention must roll the cache back to the "
         "PRE-REQUEST cursor via `removeLastNTokens`, matching the "
         "hybrid cancel semantics";
}

// PR #2813 fix regression: on a pure-attention driver, the pre-request
// rollback anchor MUST be captured AFTER `preparePrefill`. If captured
// before, an in-prefill `trySlidePrefill` lowers `nPast_` but leaves
// `preRequestNPast_` at the stale pre-slide cursor; a subsequent cancel
// then under-trims `removeLastNTokens` and leaves `discard` tokens of
// the cancelled prompt live in KV under the previous turn's
// `firstMsgTokens_` bookkeeping — silent contamination of the next turn.
TEST_F(
    TextLlmContextCancelTest,
    OnCancelAfterPrefillSlideRollsBackToPostSlideCursor) {
  // Small ctx_size so the slide trigger is reachable without decoding
  // thousands of tokens per turn.
  const std::string modelPath = qwen3PureAttentionModelPath();
  if (!modelFileExists(modelPath)) {
    GTEST_SKIP() << "Qwen3-0.6B pure-attention model not found";
  }
  std::unordered_map<std::string, std::string> config;
  config["device"] = test_common::getTestDevice();
  config["ctx_size"] = "512";
  config["gpu_layers"] = test_common::getTestGpuLayers();
  config["n_predict"] = "8";
  config["backendsDir"] = test_common::getTestBackendsDir().string();
  std::string mp = modelPath;
  std::string proj;
  auto model = std::make_unique<LlamaModel>(
      std::move(mp), std::move(proj), std::move(config));
  model->waitForLoadInitialization();
  ASSERT_TRUE(model->isLoaded());

  LlmModelContext shared = makeShared(*model);
  ToolsCompactController tools(std::nullopt);
  common_params params = model->getCommonParams();
  TextLlmContext driver(params, shared, tools, /*seqId=*/0);
  // Non-zero discard budget so overflow slides instead of throwing.
  driver.setNDiscarded(128);

  auto repeat = [](const std::string& unit, size_t times) {
    std::string out;
    out.reserve(unit.size() * times);
    for (size_t i = 0; i < times; ++i) {
      out += unit;
    }
    return out;
  };

  // Turn 1 (small opener) keeps `firstMsgTokens_` modest so turn 3's
  // slide budget is not dominated by the protected prefix.
  const LlmContext::EvalMessageResult turn1Result = driver.evalMessageWithTools(
      {makeMsg("user", "Hi")},
      {},
      /*isCacheLoaded=*/false,
      /*prefill=*/true);
  ASSERT_TRUE(turn1Result.ok);
  EXPECT_FALSE(turn1Result.cancelled);
  EXPECT_TRUE(turn1Result.rollbackOk);

  // Turn 2 fills context toward the ceiling (~350 tokens on Qwen3).
  const std::string bulk = repeat("The quick brown fox jumps. ", /*times=*/65);
  const LlmContext::EvalMessageResult turn2Result = driver.evalMessageWithTools(
      {makeMsg("user", bulk)},
      {},
      /*isCacheLoaded=*/false,
      /*prefill=*/true);
  ASSERT_TRUE(turn2Result.ok);
  EXPECT_FALSE(turn2Result.cancelled);
  EXPECT_TRUE(turn2Result.rollbackOk);
  const llama_pos preRequestNPast = driver.getNPast();
  const llama_pos preRequestFirstMsg = driver.getFirstMsgTokens();
  ASSERT_GT(preRequestNPast, preRequestFirstMsg)
      << "turn 2 must have advanced past the first-message prefix";
  const int32_t preRequestSlides = driver.getNSlides();
  const llama_pos ctxSize =
      static_cast<llama_pos>(llama_n_ctx(model->getContext()));
  ASSERT_GT(preRequestNPast, ctxSize / 2)
      << "turn 2 did not consume enough context to force a slide on "
         "turn 3; increase the bulk repeat count. nPast="
      << preRequestNPast << " ctxSize=" << ctxSize;

  // Turn 3 sized so `preRequestNPast + nTokens > ctx_size` forces
  // `trySlidePrefill` to run before decode.
  const std::string overflow = repeat("Please describe. ", /*times=*/50);
  const LlmContext::EvalMessageResult turn3Result = driver.evalMessageWithTools(
      {makeMsg("user", overflow)},
      {},
      /*isCacheLoaded=*/false,
      /*prefill=*/true);
  ASSERT_TRUE(turn3Result.ok);
  EXPECT_FALSE(turn3Result.cancelled);
  EXPECT_TRUE(turn3Result.rollbackOk);
  ASSERT_GT(driver.getNSlides(), preRequestSlides)
      << "turn 3 must have triggered a context slide in preparePrefill "
         "for the regression assertion to be meaningful. preRequestNPast="
      << preRequestNPast << " ctxSize=" << ctxSize;

  bool rollbackOk = false;
  EXPECT_NO_THROW(rollbackOk = driver.onCancel([](const std::string&) {}));
  EXPECT_TRUE(rollbackOk)
      << "pure-attention onCancel after a slide must still report rollback-ok";

  const llama_pos postCancelNPast = driver.getNPast();
  EXPECT_LT(postCancelNPast, preRequestNPast)
      << "onCancel after a prefill slide must restore to the POST-slide "
         "cursor. With the pre-fix ordering (anchor captured before "
         "`preparePrefill`) the anchor would still be `preRequestNPast` "
         "and rollback would under-trim, leaving `discard` cancelled "
         "prompt tokens live in KV.";
  EXPECT_EQ(driver.getFirstMsgTokens(), preRequestFirstMsg)
      << "the slide does not touch the first-message prefix; the "
         "rollback must preserve `firstMsgTokens_`";
  EXPECT_EQ(seqPosMax(*model), postCancelNPast - 1)
      << "live KV must be trimmed to match the restored cursor after "
         "cancel — any leftover cells past `postCancelNPast - 1` are "
         "contamination of the next turn";

  const LlmContext::EvalMessageResult recoveryResult =
      driver.evalMessageWithTools(
          {makeMsg("user", "Recovery ping")},
          {},
          /*isCacheLoaded=*/false,
          /*prefill=*/true);
  EXPECT_TRUE(recoveryResult.ok)
      << "post-cancel prefill must succeed on the rolled-back cache";
  EXPECT_FALSE(recoveryResult.cancelled);
  EXPECT_TRUE(recoveryResult.rollbackOk);
}

// ============================================================================
// User-visible perf snapshot lifecycle on `TextLlmContext`
// ============================================================================
//
// `compactThinkSpan` freezes the perf counters just before any recurrent
// replay decode runs, so `runtimeStats()` can report the pre-replay
// (user-visible) values rather than counters inflated by internal cache
// maintenance. The capture is gated on
// `needsRecurrentSnapshot_ && compactor_.hasOpenSpan()` because:
//   * pure-attention compaction does not replay (no inflation to freeze
//     against — the live read is already correct), and
//   * capturing for pure-attention races against lazy GPU-side decode
//     telemetry (the snapshot can lag the live counters by one token
//     because the final `llama_synchronize()` happens later in
//     `resetState`).
// The base `LlmContext::takeUserVisiblePerfSnapshot` returns `nullopt`
// by default; `TextLlmContext` overrides it to consume the captured
// snapshot. Hybrid coverage (snapshot actually populated and consumed)
// lives in the `reasoning.test.js` integration suite — driving a hybrid
// inference with reasoning content from a unit test would require
// reproducing a non-trivial chunk of the model harness.

// Newly constructed driver: no snapshot. Guards the initial state — a
// stray non-empty snapshot here would leak into the first inference's
// `runtimeStats()` and report zeroed-out counters.
TEST_F(TextLlmContextCancelTest, FreshDriverReportsNoUserVisiblePerfSnapshot) {
  auto model = loadTextModel(qwen3PureAttentionModelPath());
  if (!model) {
    GTEST_SKIP() << "Qwen3-0.6B pure-attention model not found";
  }

  LlmModelContext shared = makeShared(*model);
  ToolsCompactController tools(std::nullopt);
  common_params params = model->getCommonParams();
  TextLlmContext driver(params, shared, tools, /*seqId=*/0);

  EXPECT_FALSE(driver.takeUserVisiblePerfSnapshot().has_value())
      << "Newly constructed driver must report no user-visible perf snapshot";
}

// Pure-attention models do not need (and do not capture) a user-visible
// perf snapshot in `compactThinkSpan`: the only purpose of the
// snapshot is to freeze `n_p_eval` / `t_p_eval_ms` BEFORE the recurrent
// replay decode inflates them, and pure-attention compaction is a pure
// cache-edit (`seq_rm + seq_add`) with no replay. Capturing for pure-
// attention also opens a one-token race against lazy GPU-side decode
// telemetry, so the capture is now gated on
// `needsRecurrentSnapshot_ && compactor_.hasOpenSpan()`. This test
// pins the contract: a pure-attention inference must leave the
// snapshot empty so `runtimeStats()` falls back to the live read.
TEST_F(
    TextLlmContextCancelTest,
    CompactThinkSpanLeavesPerfSnapshotEmptyForPureAttention) {
  auto model = loadTextModel(qwen3PureAttentionModelPath());
  if (!model) {
    GTEST_SKIP() << "Qwen3-0.6B pure-attention model not found";
  }

  LlmModelContext shared = makeShared(*model);
  ToolsCompactController tools(std::nullopt);
  common_params params = model->getCommonParams();
  TextLlmContext driver(params, shared, tools, /*seqId=*/0);

  std::vector<common_chat_msg> chatMsgs = {makeMsg("user", "Hi")};
  const LlmContext::EvalMessageResult evalResult = driver.evalMessageWithTools(
      chatMsgs, {}, /*isCacheLoaded=*/false, /*prefill=*/false);
  ASSERT_TRUE(evalResult.ok);
  EXPECT_FALSE(evalResult.cancelled);
  EXPECT_TRUE(evalResult.rollbackOk);
  ASSERT_TRUE(driver.generateResponse([](const std::string&) {}).ok);

  EXPECT_FALSE(driver.takeUserVisiblePerfSnapshot().has_value())
      << "Pure-attention compactThinkSpan must NOT capture a snapshot — "
         "the live read in runtimeStats is already correct and capturing "
         "early races against lazy GPU perf telemetry";
}

// ============================================================================
// Layer 2b: MtmdLlmContext cancel paths via the high-level LlamaModel API
// ============================================================================
//
// `MtmdLlmContext` is constructed indirectly inside `LlamaModel` and its
// cancel flag (`stopGeneration_`) is only propagated when an inference is
// already in flight (see `LlamaModel::cancelImpl`). The deterministic
// "stop before evalMessageWithTools" pattern we use for `TextLlmContext`
// doesn't transfer here without direct construction, which requires a
// `common_init_result_ptr` that the model owns internally. So we drive
// these scenarios end-to-end with a worker thread + `LlamaModel::cancel`,
// mirroring the existing `AddonCppTest.StopDuringGeneration` pattern.

class MtmdLlmContextCancelTest : public ::testing::Test {};

// TODO #1 coverage: cancel an in-flight hybrid multimodal inference and
// verify the model survives — i.e. the next prompt succeeds. This is a
// recovery-only assertion because the mtmd prefill loop processes each
// text chunk as a single atomic `mtmd_helper_eval_chunk_single` call,
// so a text-only prompt collapses to one chunk with exactly one cancel
// check at the very top. The mid-prefill rollback case (cancel landing
// AFTER at least one chunk has decoded) is exercised by the sibling
// `CancelDuringImageChunkRollsBackHybridMtmdCache` test below, which
// guarantees multiple chunks by attaching an image.
TEST_F(MtmdLlmContextCancelTest, CancelDuringPrefillLeavesHybridMtmdUsable) {
  auto model = loadMtmdModel(qwen35HybridModelPath(), qwen35MmprojPath());
  if (!model) {
    GTEST_SKIP() << "Qwen3.5 hybrid multimodal model not found";
  }

  // Prefill-only call so generation timing is not a factor.
  LlamaModel::Prompt cancelTargetPrompt;
  cancelTargetPrompt.input = R"([
    {"role":"user","content":"Cancel target: a moderately long prompt that gives the worker a chance to start prefill before cancel fires."}
  ])";
  cancelTargetPrompt.prefill = true;

  std::atomic<bool> done{false};
  std::thread worker([&] {
    try {
      model->processPrompt(cancelTargetPrompt);
    } catch (...) {
      // Cancel may surface as a status error; treat as a clean cancel.
    }
    done.store(true);
  });

  // Brief head start so the worker enters the prefill loop.
  std::this_thread::sleep_for(std::chrono::milliseconds(50));
  EXPECT_NO_THROW(model->cancel());

  // Wait for the worker to unwind.
  auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
  while (!done.load() && std::chrono::steady_clock::now() < deadline) {
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
  ASSERT_TRUE(done.load()) << "worker did not unwind within 10s of cancel";
  worker.join();

  // Recovery: the model must accept another inference cleanly.
  LlamaModel::Prompt recovery = makeMtmdRecoveryPrompt();
  EXPECT_NO_THROW({ (void)model->processPrompt(recovery); });
}

// TODO #2 coverage: cancel a hybrid multimodal prefill AFTER an image
// chunk has been committed to the KV cache (or at least started). The
// previous metadata-resync workaround failed exactly here because
// `llama_memory_seq_pos_max` does not report Qwen3VL M-RoPE x/y
// coordinates stored as extended metadata on image cells; the snapshot
// path captures the full sequence state including those coordinates,
// so cancel can drop the image-chunk cells along with everything else.
// Asserts the rollback brings the cache back to empty and a follow-up
// inference works.
TEST_F(
    MtmdLlmContextCancelTest, CancelDuringImageChunkRollsBackHybridMtmdCache) {
  auto model = loadMtmdModel(qwen35HybridModelPath(), qwen35MmprojPath());
  if (!model) {
    GTEST_SKIP() << "Qwen3.5 hybrid multimodal model not found";
  }

  const fs::path imagePath = multimodalTestImagePath();
  if (!fs::exists(imagePath)) {
    GTEST_SKIP() << "Multimodal test image not found at " << imagePath;
  }

  // Prompt with an image chunk followed by a text chunk — the exact
  // shape the deleted metadata-resync workaround was designed for
  // (cancel landing between chunks).
  LlamaModel::Prompt prompt;
  prompt.input =
      R"([{"role": "user", "type": "media", "content": ""},)"
      R"( {"role": "user", "content": "Describe this image in detail with as much length as possible to give the cancel signal a wide mid-prefill window."}])";
  prompt.media.push_back(readBinaryFile(imagePath));
  prompt.prefill = true;

  std::atomic<bool> done{false};
  std::thread worker([&] {
    try {
      model->processPrompt(prompt);
    } catch (...) {
      // Cancel may surface as a status error; treat as a clean cancel.
    }
    done.store(true);
  });

  // Image-chunk decoding on Qwen3.5 vision typically takes well over
  // 50ms even on M-series; this head start reliably lands cancel while
  // the prefill loop is still iterating chunks.
  std::this_thread::sleep_for(std::chrono::milliseconds(50));
  EXPECT_NO_THROW(model->cancel());

  auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(15);
  while (!done.load() && std::chrono::steady_clock::now() < deadline) {
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
  ASSERT_TRUE(done.load()) << "worker did not unwind within 15s of cancel";
  worker.join();

  // Strong assertion: the snapshot must have rolled the cache back to
  // empty, including any image-chunk KV cells that were committed
  // before cancel landed. If the deleted metadata-resync workaround
  // were still in effect this would fail because `seq_pos_max` cannot
  // see the image-chunk extended metadata.
  EXPECT_EQ(seqPosMax(*model), -1)
      << "cancelled hybrid mtmd prefill with image chunk must restore "
         "the pre-prefill cursor; non-empty cache means image-chunk "
         "cells leaked past cancel";

  // Recovery: the model must accept another inference (with or without
  // an image) cleanly on the rolled-back cache.
  LlamaModel::Prompt recovery = makeMtmdRecoveryPrompt();
  EXPECT_NO_THROW({ (void)model->processPrompt(recovery); });
}

// Same recovery property on a pure-attention multimodal model (SmolVLM).
// Regression guard: our changes to the prefill cancel block in
// `MtmdLlmContext::evalMessageWithTools` must not change the existing
// pure-attention cancel behaviour.
TEST_F(
    MtmdLlmContextCancelTest,
    CancelDuringPrefillLeavesPureAttentionMtmdUsable) {
  const std::string smolvlmPath = test_common::BaseTestModelPath::get(
      "SmolVLM-500M-Instruct-Q8_0.gguf", "SmolVLM-500M-Instruct.gguf");
  const std::string smolvlmMmproj = test_common::BaseTestModelPath::get(
      "mmproj-SmolVLM-500M-Instruct-Q8_0.gguf",
      "mmproj-SmolVLM-500M-Instruct.gguf");
  auto model = loadMtmdModel(smolvlmPath, smolvlmMmproj);
  if (!model) {
    GTEST_SKIP() << "SmolVLM pure-attention multimodal model not found";
  }

  LlamaModel::Prompt cancelTargetPrompt;
  cancelTargetPrompt.input = R"([
    {"role":"user","content":"Cancel target: a moderately long prompt for the pure-attention multimodal cancel path."}
  ])";
  cancelTargetPrompt.prefill = true;

  std::atomic<bool> done{false};
  std::thread worker([&] {
    try {
      model->processPrompt(cancelTargetPrompt);
    } catch (...) {
      // Cancel may surface as a status error; treat as a clean cancel.
    }
    done.store(true);
  });

  std::this_thread::sleep_for(std::chrono::milliseconds(50));
  EXPECT_NO_THROW(model->cancel());

  auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
  while (!done.load() && std::chrono::steady_clock::now() < deadline) {
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
  ASSERT_TRUE(done.load());
  worker.join();

  LlamaModel::Prompt recovery = makeMtmdRecoveryPrompt();
  EXPECT_NO_THROW({ (void)model->processPrompt(recovery); });
}

// ============================================================================
// Layer 2c: end-to-end cancel during generation via the high-level API
// ============================================================================

// Threaded cancel test: spawn the inference, set the cancel flag from
// another thread, then verify that the model survives and a follow-up
// inference still works. This is the only test that exercises the
// generation-cancel restore path (`TextLlmContext::onCancel` with a real
// in-flight generation).
//
// Test is timing-sensitive: retry with a fresh context and issue cancel from
// the streaming callback after generated output starts. That avoids accepting a
// run where the decode completed before the cancel signal reached the context.
TEST(
    TextLlmContextCancelDuringGenerationTest, HybridModelSurvivesMidGenCancel) {
  const std::string modelPath =
      test_common::BaseTestModelPath::get("Qwen3.5-0.8B-Q8_0.gguf");
  if (!fs::exists(modelPath)) {
    GTEST_SKIP() << "Qwen3.5 hybrid model not found";
  }

  constexpr int kMaxAttempts = 3;
  for (int attempt = 1; attempt <= kMaxAttempts; ++attempt) {
    std::unordered_map<std::string, std::string> config;
    config["device"] = test_common::getTestDevice();
    config["ctx_size"] = "4096";
    config["gpu_layers"] = test_common::getTestGpuLayers();
    config["n_predict"] = "256"; // long enough to cancel mid-flight
    config["backendsDir"] = test_common::getTestBackendsDir().string();

    std::string mp = modelPath;
    std::string proj;
    auto model = std::make_unique<LlamaModel>(
        std::move(mp), std::move(proj), std::move(config));
    model->waitForLoadInitialization();
    ASSERT_TRUE(model->isLoaded());
    LlmContext* baseCtx = LlamaModelTestPeer::llmContext(*model);
    ASSERT_NE(baseCtx, nullptr);

    std::atomic<bool> cancelIssued{false};
    std::atomic<unsigned> callbackCount{0};
    std::exception_ptr generationError;

    LlamaModel::Prompt longPrompt;
    longPrompt.input = R"([
      {"role":"user","content":"Write a long story about a dragon."}
    ])";
    // `remove_thinking_from_context` does NOT gate the cancel-restore
    // path anymore — that path now uses the `prefillEntry` snapshot,
    // which is captured unconditionally for hybrid / recurrent models.
    // We leave the flag enabled so this test also exercises the
    // `reasoningBoundary` capture lifecycle alongside the cancel path,
    // catching regressions where the two snapshots interfere with each
    // other.
    longPrompt.generationParams.remove_thinking_from_context = true;
    longPrompt.outputCallback = [&](const std::string&) {
      const unsigned seen = callbackCount.fetch_add(1) + 1;
      if (seen >= 2 && !cancelIssued.exchange(true)) {
        baseCtx->stop();
      }
    };

    std::atomic<bool> generationDone{false};
    std::thread gen([&] {
      try {
        model->processPrompt(longPrompt);
      } catch (...) {
        generationError = std::current_exception();
      }
      generationDone.store(true);
    });

    auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(15);
    while (!generationDone.load() &&
           std::chrono::steady_clock::now() < deadline) {
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    ASSERT_TRUE(generationDone.load())
        << "model did not unwind within 15s of callback cancel attempt "
        << attempt;
    gen.join();

    if (!cancelIssued.load()) {
      continue;
    }

    if (generationError != nullptr) {
      try {
        std::rethrow_exception(generationError);
      } catch (const std::exception& ex) {
        FAIL() << "generation threw after callback cancel on attempt "
               << attempt << ": " << ex.what();
      } catch (...) {
        FAIL() << "generation threw non-std exception after callback cancel on "
                  "attempt "
               << attempt;
      }
    }

    ASSERT_GE(callbackCount.load(), 2u)
        << "cancel must be issued after generated output has started";

    // Recovery: subsequent inference must succeed on the cancelled context.
    LlamaModel::Prompt shortPrompt;
    shortPrompt.input = R"([{"role":"user","content":"Hi"}])";
    shortPrompt.generationParams.remove_thinking_from_context = false;
    EXPECT_NO_THROW({
      std::string output = model->processPrompt(shortPrompt);
      EXPECT_GT(output.length(), 0u);
    });
    return;
  }
  FAIL() << "generation finished before callback-triggered cancel across "
         << kMaxAttempts << " attempts";
}

TEST(
    TextLlmContextCancelDuringGenerationTest,
    SinglePromptHybridCancelRollbackFailureSkipsCacheSave) {
  const std::string modelPath = qwen35HybridModelPath();
  if (!fs::exists(modelPath)) {
    GTEST_SKIP() << "Qwen3.5 hybrid model not found";
  }

  std::unordered_map<std::string, std::string> config;
  config["device"] = test_common::getTestDevice();
  config["ctx_size"] = "4096";
  config["gpu_layers"] = test_common::getTestGpuLayers();
  config["n_predict"] = "32";
  config["backendsDir"] = test_common::getTestBackendsDir().string();

  std::string mp = modelPath;
  std::string proj;
  auto model = std::make_unique<LlamaModel>(
      std::move(mp), std::move(proj), std::move(config));
  model->waitForLoadInitialization();
  ASSERT_TRUE(model->isLoaded());

  const fs::path cachePath =
      fs::temp_directory_path() /
      ("single-cancel-rollback-" +
       std::to_string(
           std::chrono::steady_clock::now().time_since_epoch().count()) +
       ".ggsq");
  fs::remove(cachePath);

  LlamaModel::Prompt seed;
  seed.input = R"([{"role":"user","content":"Remember the clean baseline."}])";
  seed.prefill = true;
  seed.cacheKey = cachePath.string();
  seed.saveCacheToDisk = true;
  ASSERT_NO_THROW(model->processPrompt(seed));
  ASSERT_TRUE(fs::exists(cachePath));
  ASSERT_GT(fs::file_size(cachePath), 0u);

  const std::vector<uint8_t> before = readBinaryFile(cachePath);
  ASSERT_FALSE(before.empty());

  LlmContext* baseCtx = LlamaModelTestPeer::llmContext(*model);
  ASSERT_NE(baseCtx, nullptr);
  auto* textCtx = dynamic_cast<TextLlmContext*>(baseCtx);
  ASSERT_NE(textCtx, nullptr);
  const llama_pos preRequestNPast = baseCtx->getNPast();
  ASSERT_GT(preRequestNPast, 0);

  std::atomic<bool> injectedFailure{false};
  LlamaModel::Prompt cancellable;
  cancellable.input =
      R"([{"role":"user","content":"Start answering, then cancel."}])";
  cancellable.cacheKey = cachePath.string();
  cancellable.saveCacheToDisk = true;
  cancellable.generationParams.remove_thinking_from_context = true;
  cancellable.outputCallback = [&](const std::string&) {
    if (injectedFailure.exchange(true)) {
      return;
    }
    // Force the single-prompt cancel rollback restore to fail after the
    // prefill-entry gate succeeds. The correct response is to return
    // rollbackOk=false up to processPromptImpl(), which then skips
    // saveCacheToDisk and preserves the existing cache file.
    textCtx->seedPrefillEntryRollbackForTesting(preRequestNPast);
    baseCtx->stop();
  };

  ASSERT_NO_THROW(model->processPrompt(cancellable));
  ASSERT_TRUE(injectedFailure.load())
      << "test did not reach the streaming callback to inject rollback failure";

  const std::vector<uint8_t> after = readBinaryFile(cachePath);
  EXPECT_EQ(after, before)
      << "single-prompt cancel with failed recurrent rollback must leave the "
         "last known-good on-disk cache untouched";

  LlamaModel::Prompt uncached;
  uncached.input = R"([{"role":"user","content":"Run after failed cancel."}])";
  uncached.generationParams.remove_thinking_from_context = false;
  ASSERT_NO_THROW(model->processPrompt(uncached));

  const std::vector<uint8_t> afterUncachedTransition =
      readBinaryFile(cachePath);
  EXPECT_EQ(afterUncachedTransition, before)
      << "failed rollback must also invalidate the active cache session; "
         "otherwise a later prompt without cacheKey saves dirty live state "
         "before clearing the cache";

  fs::remove(cachePath);
}

TEST(
    TextLlmContextCancelDuringGenerationTest,
    SinglePromptHybridPrefillCancelRollbackFailureInvalidatesCacheSession) {
  const std::string modelPath = qwen35HybridModelPath();
  if (!fs::exists(modelPath)) {
    GTEST_SKIP() << "Qwen3.5 hybrid model not found";
  }

  std::unordered_map<std::string, std::string> config;
  config["device"] = test_common::getTestDevice();
  config["ctx_size"] = "4096";
  config["gpu_layers"] = test_common::getTestGpuLayers();
  config["n_predict"] = "8";
  config["batch-size"] = "1";
  config["backendsDir"] = test_common::getTestBackendsDir().string();

  std::string mp = modelPath;
  std::string proj;
  auto model = std::make_unique<LlamaModel>(
      std::move(mp), std::move(proj), std::move(config));
  model->waitForLoadInitialization();
  ASSERT_TRUE(model->isLoaded());

  const fs::path cachePath =
      fs::temp_directory_path() /
      ("single-prefill-cancel-rollback-" +
       std::to_string(
           std::chrono::steady_clock::now().time_since_epoch().count()) +
       ".ggsq");
  fs::remove(cachePath);

  LlamaModel::Prompt seed;
  seed.input = R"([{"role":"user","content":"Remember the clean baseline."}])";
  seed.prefill = true;
  seed.cacheKey = cachePath.string();
  seed.saveCacheToDisk = true;
  ASSERT_NO_THROW(model->processPrompt(seed));
  ASSERT_TRUE(fs::exists(cachePath));

  const std::vector<uint8_t> before = readBinaryFile(cachePath);
  ASSERT_FALSE(before.empty());

  LlmContext* baseCtx = LlamaModelTestPeer::llmContext(*model);
  ASSERT_NE(baseCtx, nullptr);
  auto* textCtx = dynamic_cast<TextLlmContext*>(baseCtx);
  ASSERT_NE(textCtx, nullptr);
  textCtx->forcePrefillEntryRestoreFailureForTesting(true);

  std::string longBody;
  for (int i = 0; i < 220; ++i) {
    longBody += "prefill cancellation rollback failure marker ";
  }

  LlamaModel::Prompt cancellable;
  cancellable.input = R"([{"role":"user","content":")" + longBody + R"("}])";
  cancellable.prefill = true;
  cancellable.cacheKey = cachePath.string();
  cancellable.saveCacheToDisk = true;

  std::atomic<bool> done{false};
  std::thread worker([&] {
    try {
      model->processPrompt(cancellable);
    } catch (...) {
      // Treat any cancel-surface exception as a completed cancel for this test.
    }
    done.store(true);
  });

  std::this_thread::sleep_for(std::chrono::milliseconds(25));
  baseCtx->stop();

  auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
  while (!done.load() && std::chrono::steady_clock::now() < deadline) {
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  ASSERT_TRUE(done.load()) << "worker did not unwind within 10s of cancel";
  worker.join();

  const std::vector<uint8_t> after = readBinaryFile(cachePath);
  EXPECT_EQ(after, before)
      << "prefill cancel with failed recurrent rollback must leave the "
         "last known-good on-disk cache untouched";

  LlamaModel::Prompt uncached;
  uncached.input =
      R"([{"role":"user","content":"Run after failed prefill cancel."}])";
  uncached.generationParams.remove_thinking_from_context = false;
  ASSERT_NO_THROW(model->processPrompt(uncached));

  const std::vector<uint8_t> afterUncachedTransition =
      readBinaryFile(cachePath);
  EXPECT_EQ(afterUncachedTransition, before)
      << "prefill rollback failure must invalidate the active cache session; "
         "otherwise a later prompt without cacheKey saves dirty live state "
         "before clearing the cache";

  fs::remove(cachePath);
}

// Mid-prefill cancel on a hybrid model via the high-level API. Unlike the
// `PrefillCancelAtEntry*` cases above (which set the stop flag before
// `evalMessageWithTools` runs and never decode any chunks), this test
// signals cancel from another thread AFTER prefill has started. A
// sufficiently long prompt + low `n_batch` ensures the prefill loop
// crosses the cancel check at least once with `tokenIndex > 0`, exercising
// the snapshot restore path. The post-cancel cache cursor must roll back
// to the pre-prefill position so subsequent inference is unaffected.
TEST(
    TextLlmContextCancelDuringGenerationTest,
    MidPrefillCancelRollsBackHybridCache) {
  const std::string modelPath = qwen35HybridModelPath();
  if (!fs::exists(modelPath)) {
    GTEST_SKIP() << "Qwen3.5 hybrid model not found";
  }

  std::unordered_map<std::string, std::string> config;
  config["device"] = test_common::getTestDevice();
  config["ctx_size"] = "4096";
  config["gpu_layers"] = test_common::getTestGpuLayers();
  config["n_predict"] = "8";
  // Force a multi-chunk prefill so cancel can land mid-loop with at
  // least one chunk already decoded. `batch-size` is the llama.cpp
  // config knob honored by LlamaModel; small value + long prompt
  // guarantees many chunks.
  config["batch-size"] = "16";
  config["backendsDir"] = test_common::getTestBackendsDir().string();

  std::string mp = modelPath;
  std::string proj;
  auto model = std::make_unique<LlamaModel>(
      std::move(mp), std::move(proj), std::move(config));
  model->waitForLoadInitialization();
  ASSERT_TRUE(model->isLoaded());

  // Long prompt: with batch-size=16 this is dozens of chunks, giving the
  // worker plenty of opportunities to observe the cancel flag mid-loop.
  // The prompt is deliberately large so the 50ms head start below
  // reliably lands cancel AFTER the first chunk has been decoded — the
  // case that actually exercises the partial-prefill rollback path
  // rather than a degenerate "cancel before any decode" restore-to-empty.
  LlamaModel::Prompt longPrompt;
  longPrompt.input = R"([
    {"role":"user","content":"This is a deliberately long user message that the prefill loop must consume across many chunks. The point of this prompt is to make the cancel signal land well inside the prefill loop so the snapshot-restore rollback path runs with multiple decoded chunks already in the recurrent state. Keep going so this comfortably exceeds dozens of chunks at batch-size=16. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum. Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium, totam rem aperiam, eaque ipsa quae ab illo inventore veritatis et quasi architecto beatae vitae dicta sunt explicabo."}
  ])";
  longPrompt.prefill = true;

  std::atomic<bool> done{false};
  std::thread worker([&] {
    try {
      model->processPrompt(longPrompt);
    } catch (...) {
      // Cancel may surface as a status error; treat as a clean cancel.
    }
    done.store(true);
  });

  // Head start so the worker enters the prefill loop. 50ms is enough
  // for several chunks to decode on M-series Macs and CI runners given
  // batch-size=16 and the ~250-token prompt above, so cancel reliably
  // lands AFTER decoded chunks — exercising the partial-prefill
  // rollback rather than a degenerate "cancel before any decode"
  // restore-to-empty. Failure mode would be cancel landing AFTER
  // prefill completes, which the prompt length + small batch make
  // very unlikely.
  std::this_thread::sleep_for(std::chrono::milliseconds(50));
  EXPECT_NO_THROW(model->cancel());

  auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
  while (!done.load() && std::chrono::steady_clock::now() < deadline) {
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  ASSERT_TRUE(done.load()) << "worker did not unwind within 10s of cancel";
  worker.join();

  // Core assertion: the recurrent rollback must have fully rewound the
  // cache. Pre-prefill position on a fresh model is -1; any residual
  // KV cells from the cancelled prefill would push this above -1.
  EXPECT_EQ(seqPosMax(*model), -1)
      << "cancelled hybrid prefill must restore the pre-prefill cache "
         "cursor; residual cells indicate the snapshot rollback did not "
         "run or was bypassed";

  // Recovery: a fresh prefill must succeed on the rolled-back cache.
  LlamaModel::Prompt recovery;
  recovery.input = R"([{"role":"user","content":"Hi"}])";
  recovery.generationParams.remove_thinking_from_context = false;
  EXPECT_NO_THROW({
    std::string output = model->processPrompt(recovery);
    EXPECT_GT(output.length(), 0u);
  });
}

// ============================================================================
// Layer 2c: TextLlmContext reasoning-compaction failure recovery
// ============================================================================

namespace {

// `IContextSliderOps` fake that rejects every `seq_rm` call and never
// touches `seq_add`. Installed on a `ReasoningBlockCompactor` via
// `setContextSliderOpsForTesting` so `compact()` on the pure-attention
// path takes the `Outcome::Kind::FailedKvIntact` branch without a real
// llama.cpp memory rejection (which is essentially impossible to
// synthesize on a valid range).
class RejectingSliderOps final : public IContextSliderOps {
public:
  llama_pos nCtx(llama_context*) const override { return 4096; }

  ContextSliderMemoryHandle memory(llama_context* lctx) const override {
    // Forward the real handle so the compactor's own diagnostics /
    // `clearSeqOnFailure` short-circuit sensibly. Not strictly needed
    // for the pure-attention path but keeps the fake honest.
    return llama_get_memory(lctx);
  }

  bool seqRm(ContextSliderMemoryHandle, llama_seq_id, llama_pos, llama_pos)
      const override {
    ++seqRmCalls_;
    return false;
  }

  void seqAdd(
      ContextSliderMemoryHandle, llama_seq_id, llama_pos, llama_pos,
      llama_pos) const override {
    ++seqAddCalls_;
  }

  int seqRmCalls() const { return seqRmCalls_; }
  int seqAddCalls() const { return seqAddCalls_; }

private:
  mutable int seqRmCalls_ = 0;
  mutable int seqAddCalls_ = 0;
};

} // namespace

// PR #2813 fix regression: on a pure-attention driver, a `seq_rm +
// seq_add` rejection from `compactThinkSpan` must roll the LIVE KV
// cache and the driver's positional bookkeeping BACK to the
// pre-request cursor before rethrowing. Prior to the fix,
// `TextLlmContext::compactThinkSpan`'s catch handler treated every
// compaction failure as the hybrid "sequence was wiped" case and reset
// `nPast_` / `firstMsgTokens_` to zero — but live KV still held the
// previous turns' tokens, so the next request on the same driver
// decoded from a corrupted `pos=0` while KV cells covered `[0, N)`.
//
// This test primes the driver with two real prefills (so
// `preRequestNPast_` sits at a non-zero cursor N1 while `nPast_`
// advances to N1 + N2), then forces `compactThinkSpan` down the
// pure-attention failure branch via a `RejectingSliderOps` fake, and
// checks:
//   * a `StatusError` is thrown (the caller still fails the request),
//   * `nPast_` / `firstMsgTokens_` are restored to their pre-request
//     values (N1 / preRequestFirstMsg), NOT reset to zero,
//   * live-KV `seq_pos_max` matches `nPast_ - 1` so the next turn
//     decodes from a coherent baseline,
//   * the rejection short-circuited before `seq_add` fired (protects
//     the `FailedKvIntact` invariant on the compactor side).
TEST_F(
    TextLlmContextCancelTest,
    PureAttentionCompactionFailureRollsBackToPreRequestCursor) {
  auto model = loadTextModel(qwen3PureAttentionModelPath());
  if (!model) {
    GTEST_SKIP() << "Qwen3-0.6B pure-attention model not found";
  }

  LlmModelContext shared = makeShared(*model);
  ToolsCompactController tools(std::nullopt);
  common_params params = model->getCommonParams();
  TextLlmContext driver(params, shared, tools, /*seqId=*/0);
  driver.setRemoveThinkingFromContext(true);

  // Turn 1 (warm baseline). This is the "prior turn's leftover state"
  // that a next-turn compaction failure MUST NOT corrupt.
  std::vector<common_chat_msg> turn1 = {makeMsg("user", "Hi there")};
  const LlmContext::EvalMessageResult turn1Result = driver.evalMessageWithTools(
      turn1, {}, /*isCacheLoaded=*/false, /*prefill=*/true);
  ASSERT_TRUE(turn1Result.ok);
  EXPECT_FALSE(turn1Result.cancelled);
  EXPECT_TRUE(turn1Result.rollbackOk);
  const llama_pos preRequestNPast = driver.getNPast();
  ASSERT_GT(preRequestNPast, 0);
  const llama_pos preRequestFirstMsg = driver.getFirstMsgTokens();
  const llama_pos preRequestSeqMax = seqPosMax(*model);
  ASSERT_EQ(preRequestSeqMax, preRequestNPast - 1)
      << "live KV must match nPast_ after a clean prefill for this test "
         "to have a meaningful baseline";

  // Turn 2 (the request that will fail compaction). `evalMessageWithTools`
  // calls `snapshotPreRequestCursor` at entry, so `preRequestNPast_` is
  // pinned at the post-turn-1 cursor before the prefill advances
  // `nPast_` further.
  const LlmContext::EvalMessageResult turn2Result = driver.evalMessageWithTools(
      {makeMsg("user", "How are you?")},
      {},
      /*isCacheLoaded=*/false,
      /*prefill=*/true);
  ASSERT_TRUE(turn2Result.ok);
  EXPECT_FALSE(turn2Result.cancelled);
  EXPECT_TRUE(turn2Result.rollbackOk);
  const llama_pos postTurn2NPast = driver.getNPast();
  ASSERT_GT(postTurn2NPast, preRequestNPast)
      << "turn 2 prefill must advance the cursor past the pre-request "
         "cursor for the recovery-delta assertion to be meaningful";

  // Install a plausible reasoning span spanning the tail of turn 2,
  // then force the pure-attention path with a rejecting slider ops.
  auto& compactor = driver.compactorForTesting();
  compactor.setReasoningEnabled(true);
  compactor.setNeedsRecurrentSnapshot(false);
  RejectingSliderOps rejecting;
  compactor.setContextSliderOpsForTesting(&rejecting);
  const llama_pos spanStart = preRequestNPast + 1;
  const llama_pos spanEnd = postTurn2NPast - 1;
  ASSERT_LT(spanStart, spanEnd)
      << "turn 2 must have added enough tokens to host a non-degenerate "
         "reasoning span";
  compactor.setOpenSpan(spanStart);
  compactor.requestCloseCapture();
  compactor.onCloseCommitted(spanEnd);
  ASSERT_TRUE(compactor.hasCapturedCloseSpanForTesting());

  EXPECT_THROW(driver.compactThinkSpanForTesting(), qvac_errors::StatusError)
      << "compactThinkSpan must still surface the compaction failure to "
         "the caller after local rollback";
  compactor.setContextSliderOpsForTesting(nullptr);

  EXPECT_EQ(driver.getNPast(), preRequestNPast)
      << "FailedKvIntact recovery must restore nPast_ to preRequestNPast_ "
         "— the regression the fix guards is a reset to 0";
  EXPECT_EQ(driver.getFirstMsgTokens(), preRequestFirstMsg)
      << "FailedKvIntact recovery must restore firstMsgTokens_ to its "
         "pre-request value";
  EXPECT_EQ(seqPosMax(*model), preRequestSeqMax)
      << "live KV must be trimmed to match nPast_ after recovery — "
         "leftover cells past preRequestNPast_ would corrupt the next "
         "turn's decode positions";
  EXPECT_EQ(rejecting.seqRmCalls(), 1)
      << "compactor must attempt the pure-attention primitive exactly once";
  EXPECT_EQ(rejecting.seqAddCalls(), 0)
      << "seq_rm rejection must short-circuit before seq_add fires — "
         "otherwise the FailedKvIntact invariant (live KV unchanged) is "
         "violated";

  // Recovery: the driver must remain usable for a follow-up prefill on
  // the pre-request baseline that we just rolled back to.
  const LlmContext::EvalMessageResult recoveryResult =
      driver.evalMessageWithTools(
          {makeMsg("user", "Are you working?")},
          {},
          /*isCacheLoaded=*/false,
          /*prefill=*/true);
  EXPECT_TRUE(recoveryResult.ok)
      << "post-recovery prefill must succeed on the rolled-back cache";
  EXPECT_FALSE(recoveryResult.cancelled);
  EXPECT_TRUE(recoveryResult.rollbackOk);
  EXPECT_GT(driver.getNPast(), preRequestNPast);
}

TEST(
    TextLlmContextCancelDuringGenerationTest,
    SinglePromptThrownCompactionFailureInvalidatesActiveCacheSession) {
  const std::string modelPath = qwen3PureAttentionModelPath();
  if (!fs::exists(modelPath)) {
    GTEST_SKIP() << "Qwen3-0.6B pure-attention model not found";
  }

  std::unordered_map<std::string, std::string> config;
  config["device"] = test_common::getTestDevice();
  config["ctx_size"] = "4096";
  config["gpu_layers"] = test_common::getTestGpuLayers();
  config["n_predict"] = "32";
  config["backendsDir"] = test_common::getTestBackendsDir().string();

  std::string mp = modelPath;
  std::string proj;
  auto model = std::make_unique<LlamaModel>(
      std::move(mp), std::move(proj), std::move(config));
  model->waitForLoadInitialization();
  ASSERT_TRUE(model->isLoaded());

  const fs::path cachePath =
      fs::temp_directory_path() /
      ("single-compaction-throw-" +
       std::to_string(
           std::chrono::steady_clock::now().time_since_epoch().count()) +
       ".ggsq");
  fs::remove(cachePath);

  LlamaModel::Prompt seed;
  seed.input = R"([{"role":"user","content":"Remember the clean baseline."}])";
  seed.prefill = true;
  seed.cacheKey = cachePath.string();
  seed.saveCacheToDisk = true;
  ASSERT_NO_THROW(model->processPrompt(seed));
  ASSERT_TRUE(fs::exists(cachePath));

  const std::vector<uint8_t> before = readBinaryFile(cachePath);
  ASSERT_FALSE(before.empty());

  LlmContext* baseCtx = LlamaModelTestPeer::llmContext(*model);
  ASSERT_NE(baseCtx, nullptr);
  auto* textCtx = dynamic_cast<TextLlmContext*>(baseCtx);
  ASSERT_NE(textCtx, nullptr);

  RejectingSliderOps rejecting;
  bool injectedFailure = false;
  LlamaModel::Prompt failing;
  failing.input = R"([{"role":"user","content":"Please answer briefly."}])";
  failing.cacheKey = cachePath.string();
  failing.saveCacheToDisk = true;
  failing.generationParams.remove_thinking_from_context = true;
  failing.outputCallback = [&](const std::string&) {
    if (injectedFailure) {
      return;
    }
    const llama_pos pos = textCtx->getNPast();
    if (pos <= 0) {
      return;
    }
    auto& compactor = textCtx->compactorForTesting();
    compactor.setRemoveThinkingFromContext(true);
    compactor.setReasoningEnabled(true);
    compactor.setNeedsRecurrentSnapshot(false);
    compactor.setContextSliderOpsForTesting(&rejecting);
    // Seed a synthetic, resident span in the prompt tail. `compactThinkSpan`
    // runs after generation; the rejecting slider makes that final cleanup
    // throw through the high-level `processPrompt` path.
    compactor.setOpenSpan(pos - 1);
    compactor.requestCloseCapture();
    compactor.onCloseCommitted(pos);
    injectedFailure = true;
  };

  EXPECT_THROW(model->processPrompt(failing), qvac_errors::StatusError);
  textCtx->compactorForTesting().setContextSliderOpsForTesting(nullptr);
  ASSERT_TRUE(injectedFailure)
      << "test did not reach streaming callback to inject compaction failure";
  EXPECT_EQ(rejecting.seqRmCalls(), 1)
      << "high-level path must actually hit the rejecting compaction primitive";

  const std::vector<uint8_t> after = readBinaryFile(cachePath);
  EXPECT_EQ(after, before)
      << "thrown compaction failure must leave the last known-good on-disk "
         "cache untouched";

  LlamaModel::Prompt uncached;
  uncached.input =
      R"([{"role":"user","content":"Run after thrown compaction failure."}])";
  ASSERT_NO_THROW(model->processPrompt(uncached));

  const std::vector<uint8_t> afterUncachedTransition =
      readBinaryFile(cachePath);
  EXPECT_EQ(afterUncachedTransition, before)
      << "thrown compaction failure must invalidate the active cache session; "
         "otherwise a later prompt without cacheKey saves recovery state "
         "over the old cache";

  fs::remove(cachePath);
}

TEST(
    TextLlmContextCancelDuringGenerationTest,
    ExplicitSaveFailureInvalidatesActiveCacheSession) {
  const std::string modelPath = qwen3PureAttentionModelPath();
  if (!fs::exists(modelPath)) {
    GTEST_SKIP() << "Qwen3-0.6B pure-attention model not found";
  }

  std::unordered_map<std::string, std::string> config;
  config["device"] = test_common::getTestDevice();
  config["ctx_size"] = "4096";
  config["gpu_layers"] = test_common::getTestGpuLayers();
  config["n_predict"] = "8";
  config["backendsDir"] = test_common::getTestBackendsDir().string();

  std::string mp = modelPath;
  std::string proj;
  auto model = std::make_unique<LlamaModel>(
      std::move(mp), std::move(proj), std::move(config));
  model->waitForLoadInitialization();
  ASSERT_TRUE(model->isLoaded());

  const fs::path missingParent =
      fs::temp_directory_path() /
      ("explicit-save-failure-" +
       std::to_string(
           std::chrono::steady_clock::now().time_since_epoch().count()));
  const fs::path badCachePath = missingParent / "cache.ggsq";
  ASSERT_FALSE(fs::exists(missingParent))
      << "precondition: missing parent directory forces saveCache failure";

  LlamaModel::Prompt failing;
  failing.input = R"([{"role":"user","content":"This save should fail."}])";
  failing.cacheKey = badCachePath.string();
  failing.saveCacheToDisk = true;
  failing.generationParams.remove_thinking_from_context = false;
  EXPECT_THROW(model->processPrompt(failing), qvac_errors::StatusError);
  EXPECT_FALSE(fs::exists(badCachePath));

  LlamaModel::Prompt uncached;
  uncached.input =
      R"([{"role":"user","content":"Run after explicit save failure."}])";
  uncached.generationParams.remove_thinking_from_context = false;
  ASSERT_NO_THROW(model->processPrompt(uncached))
      << "explicit save failure must invalidate the active cache session; "
         "otherwise a later prompt without cacheKey retries the stale save";
}

TEST(
    TextLlmContextCancelDuringGenerationTest,
    SinglePromptOpenReasoningSpanFailureSkipsCacheSave) {
  const std::string modelPath = qwen3PureAttentionModelPath();
  if (!fs::exists(modelPath)) {
    GTEST_SKIP() << "Qwen3-0.6B pure-attention model not found";
  }

  std::unordered_map<std::string, std::string> config;
  config["device"] = test_common::getTestDevice();
  config["ctx_size"] = "4096";
  config["gpu_layers"] = test_common::getTestGpuLayers();
  config["n_predict"] = "8";
  config["backendsDir"] = test_common::getTestBackendsDir().string();

  std::string mp = modelPath;
  std::string proj;
  auto model = std::make_unique<LlamaModel>(
      std::move(mp), std::move(proj), std::move(config));
  model->waitForLoadInitialization();
  ASSERT_TRUE(model->isLoaded());

  const fs::path cachePath =
      fs::temp_directory_path() /
      ("single-open-reasoning-failure-" +
       std::to_string(
           std::chrono::steady_clock::now().time_since_epoch().count()) +
       ".ggsq");
  fs::remove(cachePath);

  LlamaModel::Prompt seed;
  seed.input = R"([{"role":"user","content":"Remember this clean cache."}])";
  seed.prefill = true;
  seed.cacheKey = cachePath.string();
  seed.saveCacheToDisk = true;
  ASSERT_NO_THROW(model->processPrompt(seed));
  ASSERT_TRUE(fs::exists(cachePath));

  const std::vector<uint8_t> before = readBinaryFile(cachePath);
  ASSERT_FALSE(before.empty());

  LlmContext* baseCtx = LlamaModelTestPeer::llmContext(*model);
  ASSERT_NE(baseCtx, nullptr);
  auto* textCtx = dynamic_cast<TextLlmContext*>(baseCtx);
  ASSERT_NE(textCtx, nullptr);

  RejectingSliderOps rejecting;
  bool injectedOpenSpan = false;
  LlamaModel::Prompt failing;
  failing.input =
      R"([{"role":"user","content":"Start reasoning but stop early."}])";
  failing.cacheKey = cachePath.string();
  failing.saveCacheToDisk = true;
  failing.generationParams.remove_thinking_from_context = true;
  failing.outputCallback = [&](const std::string&) {
    if (injectedOpenSpan) {
      return;
    }
    const llama_pos pos = textCtx->getNPast();
    if (pos <= 0) {
      return;
    }
    auto& compactor = textCtx->compactorForTesting();
    compactor.setRemoveThinkingFromContext(true);
    compactor.setReasoningEnabled(true);
    compactor.setNeedsRecurrentSnapshot(false);
    compactor.setContextSliderOpsForTesting(&rejecting);
    // Model a request that ends after `<think>` but before `</think>`:
    // the span is open and resident, but no close capture ever commits.
    compactor.setOpenSpan(pos - 1);
    injectedOpenSpan = true;
  };

  EXPECT_THROW(model->processPrompt(failing), qvac_errors::StatusError);
  textCtx->compactorForTesting().setContextSliderOpsForTesting(nullptr);
  ASSERT_TRUE(injectedOpenSpan)
      << "test did not reach streaming callback to seed the open span";
  EXPECT_EQ(rejecting.seqRmCalls(), 1)
      << "open-ended span must attempt cleanup instead of returning NoOp";
  EXPECT_EQ(rejecting.seqAddCalls(), 0)
      << "forced seq_rm rejection must fail before any seq_add shift";

  const std::vector<uint8_t> after = readBinaryFile(cachePath);
  EXPECT_EQ(after, before)
      << "open reasoning span cleanup failure must not persist reasoning "
         "state over the last known-good cache";

  LlamaModel::Prompt uncached;
  uncached.input =
      R"([{"role":"user","content":"Run after open-span failure."}])";
  ASSERT_NO_THROW(model->processPrompt(uncached));

  const std::vector<uint8_t> afterUncachedTransition =
      readBinaryFile(cachePath);
  EXPECT_EQ(afterUncachedTransition, before)
      << "open-span failure must invalidate the active cache session; "
         "otherwise a later prompt without cacheKey saves recovery state "
         "over the old cache";

  fs::remove(cachePath);
}
