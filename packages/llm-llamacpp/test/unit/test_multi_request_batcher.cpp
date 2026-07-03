#include <map>
#include <set>

#include <gtest/gtest.h>
#include <llama.h>

#include "model-interface/LlmContext.hpp"
#include "model-interface/MultiRequestBatcher.hpp"

using namespace qvac_lib_inference_addon_llama::batching;

/// Simulates llama_decode() for testing. Each batch entry whose logits
/// flag is set produces a "logit row" stored under its batch index, mimicking
/// how llama.cpp populates per-row logits. The sampler then reads those rows
/// by the logitIdx the batcher reports, exactly like
/// llama_get_logits_ith(ctx, logitIdx) in production.

TEST(MultiRequestBatcherFunctionTest, FunctionIsPrefillComplete) {
  unsigned maxTokens = 5;
  Request req(0, {10, 20, 30}, maxTokens);

  EXPECT_FALSE(req.isPrefillComplete());

  req.prefillFedCount = 1;
  EXPECT_FALSE(req.isPrefillComplete());

  req.prefillFedCount = 3;
  EXPECT_TRUE(req.isPrefillComplete());
}

TEST(MultiRequestBatcherFunctionTest, FunctionIsPrefillPending) {
  unsigned maxTokens = 5;
  Request req(0, {10, 20, 30}, maxTokens);

  EXPECT_TRUE(req.isPrefillPending());

  req.prefillFedCount = 3;
  EXPECT_FALSE(req.isPrefillPending());

  req.stopReason = StopReason::Finished;
  EXPECT_FALSE(req.isPrefillPending());
}

TEST(MultiRequestBatcherFunctionTest, FunctionIsGenerationIdle) {
  unsigned maxTokens = 5;
  Request req(0, {10, 20, 30}, maxTokens);

  EXPECT_FALSE(req.isGenerationIdle());

  req.prefillFedCount = 3;
  EXPECT_TRUE(req.isGenerationIdle());

  req.generatedTokens.push_back(40);
  req.hasUnfedSample = true;
  EXPECT_FALSE(req.isGenerationIdle());

  req.hasUnfedSample = false;
  req.currentPos = 4;
  EXPECT_TRUE(req.isGenerationIdle());

  req.stopReason = StopReason::Finished;
  EXPECT_FALSE(req.isGenerationIdle());
}

TEST(MultiRequestBatcherFunctionTest, FunctionIsGenerationPending) {
  unsigned maxTokens = 5;
  Request req(0, {10, 20, 30}, maxTokens);

  EXPECT_FALSE(req.isGenerationPending());

  req.prefillFedCount = 3;
  EXPECT_FALSE(req.isGenerationPending());

  req.generatedTokens.push_back(40);
  req.hasUnfedSample = true;
  EXPECT_TRUE(req.isGenerationPending());

  req.stopReason = StopReason::Finished;
  EXPECT_FALSE(req.isGenerationPending());
}

TEST(MultiRequestBatcherFunctionTest, FunctionIsFinished) {
  unsigned maxTokens = 5;
  Request req(0, {10, 20, 30}, maxTokens);

  EXPECT_FALSE(req.isFinished());

  req.stopReason = StopReason::Finished;
  EXPECT_TRUE(req.isFinished());
}

TEST(MultiRequestBatcherFunctionTest, FunctionExceededLimit) {
  unsigned maxTokens = 2;
  Request req(1, {100}, maxTokens);

  req.currentPos = 1;
  req.prefillFedCount = 1;
  req.generatedTokens.push_back(200);
  req.currentPos = 2;

  EXPECT_TRUE(req.exceededLimit());
  EXPECT_TRUE(req.isFinished());
  EXPECT_FALSE(req.isPrefillPending());
  EXPECT_FALSE(req.isGenerationIdle());
  EXPECT_FALSE(req.isGenerationPending());
}

TEST(MultiRequestBatcherFunctionTest, FunctionRemainingToFeed) {
  unsigned maxTokens = 10;
  Request req(0, {10, 20, 30}, maxTokens);

  EXPECT_EQ(req.remainingToFeed(), 3u);

  req.prefillFedCount = 1;
  EXPECT_EQ(req.remainingToFeed(), 2u);

  req.prefillFedCount = 0;
  req.pendingPrefillTokens.clear();
  EXPECT_EQ(req.remainingToFeed(), 0u);

  req.generatedTokens.push_back(99);
  req.hasUnfedSample = true;
  EXPECT_EQ(req.remainingToFeed(), 1u);

  req.hasUnfedSample = false;
  EXPECT_EQ(req.remainingToFeed(), 0u);
}

TEST(MultiRequestBatcherFunctionTest, FunctionTokenToFeedAt) {
  unsigned maxTokens = 10;
  Request req(0, {10, 20, 30}, maxTokens);

  EXPECT_EQ(req.tokenToFeedAt(0), 10);
  EXPECT_EQ(req.tokenToFeedAt(1), 20);
  EXPECT_EQ(req.tokenToFeedAt(2), 30);

  req.prefillFedCount = 1;
  EXPECT_EQ(req.tokenToFeedAt(0), 20);
  EXPECT_EQ(req.tokenToFeedAt(1), 30);

  req.prefillFedCount = 0;
  req.pendingPrefillTokens.clear();
  req.generatedTokens.push_back(7);
  req.hasUnfedSample = true;
  EXPECT_EQ(req.tokenToFeedAt(0), 7);
}

TEST(MultiRequestBatcherFunctionTest, FunctionChunkConsumesAllUnfed) {
  unsigned maxTokens = 10;
  Request req(0, {10, 20, 30}, maxTokens);

  EXPECT_FALSE(req.chunkConsumesAllUnfed(1));
  EXPECT_FALSE(req.chunkConsumesAllUnfed(2));
  EXPECT_TRUE(req.chunkConsumesAllUnfed(3));

  req.prefillFedCount = 1;
  EXPECT_FALSE(req.chunkConsumesAllUnfed(1));
  EXPECT_TRUE(req.chunkConsumesAllUnfed(2));

  req.prefillFedCount = 0;
  req.pendingPrefillTokens.clear();
  req.generatedTokens.push_back(99);
  req.hasUnfedSample = true;
  EXPECT_TRUE(req.chunkConsumesAllUnfed(1));
  EXPECT_FALSE(req.chunkConsumesAllUnfed(2));

  req.hasUnfedSample = false;
  EXPECT_TRUE(req.chunkConsumesAllUnfed(0));
  EXPECT_FALSE(req.chunkConsumesAllUnfed(1));
}

TEST(MultiRequestBatcherFunctionTest, FunctionStaticHelpers) {
  std::optional<Request> emptySlot = std::nullopt;
  EXPECT_FALSE(Request::isOptPrefillPending(emptySlot));
  EXPECT_FALSE(Request::isOptGenerationIdle(emptySlot));
  EXPECT_FALSE(Request::isOptGenerationPending(emptySlot));
  EXPECT_FALSE(Request::isOptFinished(emptySlot));

  std::optional<Request> prefillSlot = Request(0, {1}, 10);
  EXPECT_TRUE(Request::isOptPrefillPending(prefillSlot));
  EXPECT_FALSE(Request::isOptGenerationIdle(prefillSlot));
  EXPECT_FALSE(Request::isOptGenerationPending(prefillSlot));
  EXPECT_FALSE(Request::isOptFinished(prefillSlot));

  std::optional<Request> idleSlot = Request(0, {1}, 10);
  idleSlot->currentPos = 1;
  idleSlot->prefillFedCount = 1;
  EXPECT_FALSE(Request::isOptPrefillPending(idleSlot));
  EXPECT_TRUE(Request::isOptGenerationIdle(idleSlot));
  EXPECT_FALSE(Request::isOptGenerationPending(idleSlot));
  EXPECT_FALSE(Request::isOptFinished(idleSlot));

  std::optional<Request> genSlot = Request(0, {1}, 10);
  genSlot->currentPos = 1;
  genSlot->prefillFedCount = 1;
  genSlot->generatedTokens.push_back(2);
  genSlot->hasUnfedSample = true;
  EXPECT_FALSE(Request::isOptPrefillPending(genSlot));
  EXPECT_FALSE(Request::isOptGenerationIdle(genSlot));
  EXPECT_TRUE(Request::isOptGenerationPending(genSlot));
  EXPECT_FALSE(Request::isOptFinished(genSlot));

  std::optional<Request> finishedSlot = Request(0, {1}, 10);
  finishedSlot->stopReason = StopReason::Finished;
  EXPECT_FALSE(Request::isOptPrefillPending(finishedSlot));
  EXPECT_FALSE(Request::isOptGenerationIdle(finishedSlot));
  EXPECT_FALSE(Request::isOptGenerationPending(finishedSlot));
  EXPECT_TRUE(Request::isOptFinished(finishedSlot));
}

class MultiRequestBatcherTest : public ::testing::Test {
protected:
  void SetUp() override {
    // 4 requests with mixed sizes:
    //  req 0: 3 tokens     req 1: 6 tokens (large)
    //  req 2: 3 tokens     req 3: 3 tokens
    requests_.push_back({100, 200, 300});
    requests_.push_back({101, 201, 301, 401, 501, 601});
    requests_.push_back({102, 202, 302});
    requests_.push_back({103, 203, 303});

    mocked_decoded_.clear();
    mocked_logitsTokens_.clear();
  }

  /// Records every token a sequence saw, and stamps a fake "logit row"
  /// at every batch index whose logits flag is set. The row is keyed by
  /// the absolute batch index (matching llama.cpp's contract that
  /// llama_get_logits_ith(idx) returns the logits computed at row idx).
  void mocked_llama_decode(const llama_batch& batch) {
    mocked_logitRows_.clear();
    for (int i = 0; i < batch.n_tokens; i++) {
      uint32_t seqId = batch.seq_id[i][0];
      mocked_decoded_[seqId].push_back(batch.token[i]);
      if (batch.logits[i] != 0) {
        mocked_logitsTokens_[seqId].push_back(i);
        mocked_logitRows_[i] = batch.token[i];
      }
    }
  }

  /// Reads the logit row that decode wrote for `logitIdx` and returns
  /// `last_token * 10` so each sequence's stream remains deterministic.
  /// Asserts logitIdx was actually a logit-bearing row in the last batch
  /// (caught immediately if the batcher fed the sampler a stale/invalid
  /// index).
  [[nodiscard]] llama_token
  mocked_llama_sampler_sample(uint32_t /*seqId*/, int logitIdx) {
    auto it = mocked_logitRows_.find(logitIdx);
    EXPECT_NE(it, mocked_logitRows_.end())
        << "sampler invoked with non-logit batch index " << logitIdx;
    if (it == mocked_logitRows_.end()) {
      return 0;
    }
    return it->second * 10;
  }

  std::vector<std::vector<llama_token>> requests_;
  // seqId -> tokens "decoded" (in batch order)
  std::map<uint32_t, std::vector<llama_token>> mocked_decoded_;
  // seqId -> indices in the batch where logits were requested
  std::map<uint32_t, std::vector<int>> mocked_logitsTokens_;
  // batch index -> token for which a logit row was produced (last batch)
  std::map<int, llama_token> mocked_logitRows_;
};

/// Test 4 requests with batchSize=2 (only 2 concurrent slots).
/// Mixed sequence sizes: req 0=3, req 1=6, req 2=3, req 3=3 tokens.
/// kMaxChunkSize=12 (large), so chunk size is determined by smallest remaining
/// among active sequences. This synchronizes boundaries for slot reuse.
///
/// Flow:
/// - Step 1: Add req 0 (3 tokens) and req 1 (6 tokens) - 3rd rejected
/// - Step 2: Batch 1 = min(3,6)=3 → 3+3=6 tokens. Seq 0 done, slot 0 free.
/// - Step 3: Add req 2 (3 tokens) into slot 0
/// - Step 4: Batch 2 = min(3 remaining seq 1, 3 req 2)=3 → 3+3=6 tokens. Both
/// done.
/// - Step 5: Add req 3 (3 tokens) into slot 0
/// - Step 6: Batch 3 = 3 tokens (only req 3 active). Done.
TEST_F(MultiRequestBatcherTest, BatchFourRequestsWithBatchSizeTwo) {
  const unsigned kMaxChunkSize = 12; // Larger than any sequence
  const unsigned kMaxTokensPerSeq = 100;
  const size_t kBatchSize = 2;

  MultiRequestBatcher batcher(kMaxChunkSize, kMaxTokensPerSeq, kBatchSize);
  LlamaBatch batch(kMaxChunkSize * kBatchSize, 0, kBatchSize);

  // === Step 1: Add 2 requests, 3rd rejected ===
  uint32_t seqId0 = 0, seqId1 = 0;
  EXPECT_EQ(
      batcher.addRequest(
          std::vector<llama_token>(requests_[0].begin(), requests_[0].end()),
          seqId0),
      MultiRequestBatcher::AddStatus::Ok);
  EXPECT_EQ(seqId0, 0);
  EXPECT_EQ(
      batcher.addRequest(
          std::vector<llama_token>(requests_[1].begin(), requests_[1].end()),
          seqId1),
      MultiRequestBatcher::AddStatus::Ok);
  EXPECT_EQ(seqId1, 1);

  uint32_t seqIdReject = 0;
  EXPECT_EQ(
      batcher.addRequest(
          std::vector<llama_token>(requests_[2].begin(), requests_[2].end()),
          seqIdReject),
      MultiRequestBatcher::AddStatus::ErrNoFreeSlot);

  // === Step 2: Batch 1 = min(3, 6)=3 tokens per seq → 6 tokens total ===
  // seq 0 (3 tokens) finishes; seq 1 has 3 tokens remaining.
  auto result = batcher.fillBatch(batch);
  EXPECT_EQ(result.chunkSize, 3);
  EXPECT_EQ(result.numActiveSequences, 2);

  llama_batch& lBatch = *batch;
  // Sequence 0: all 3 tokens, last has logits.
  EXPECT_EQ(lBatch.seq_id[0][0], 0);
  EXPECT_EQ(lBatch.token[0], 100);
  EXPECT_EQ(lBatch.pos[0], 0);
  EXPECT_EQ(lBatch.token[1], 200);
  EXPECT_EQ(lBatch.token[2], 300);
  EXPECT_EQ(lBatch.pos[2], 2);
  EXPECT_EQ(lBatch.logits[2], 1);
  // Sequence 1: first 3 of 6 tokens, no logits yet.
  EXPECT_EQ(lBatch.seq_id[3][0], 1);
  EXPECT_EQ(lBatch.token[3], 101);
  EXPECT_EQ(lBatch.token[4], 201);
  EXPECT_EQ(lBatch.token[5], 301);
  EXPECT_EQ(lBatch.pos[5], 2);
  EXPECT_EQ(lBatch.logits[5], 0);

  batcher.advance(result.chunkSize);
  // seq 0 is prefill-complete; caller marks finished to free its slot.
  EXPECT_TRUE(batcher.markFinished(seqId0));
  auto finished0 = batcher.extractFinished();
  ASSERT_EQ(finished0.size(), 1);
  EXPECT_EQ(finished0[0].stopReason, StopReason::Finished);

  // === Step 3: Slot 0 freed - add request 2 (3 tokens) ===
  uint32_t seqId2 = 0;
  EXPECT_EQ(
      batcher.addRequest(
          std::vector<llama_token>(requests_[2].begin(), requests_[2].end()),
          seqId2),
      MultiRequestBatcher::AddStatus::Ok);
  EXPECT_EQ(seqId2, 0);

  // === Step 4: Batch 2 = min(3 remaining of seq 1, 3 of req 2)=3 → 6 tokens
  // ===
  result = batcher.fillBatch(batch);
  EXPECT_EQ(result.chunkSize, 3);
  EXPECT_EQ(result.numActiveSequences, 2);

  // Slot 0 (was request 2): tokens 102, 202, 302 starting at pos 0.
  EXPECT_EQ(lBatch.seq_id[0][0], 0);
  EXPECT_EQ(lBatch.token[0], 102);
  EXPECT_EQ(lBatch.pos[0], 0);
  EXPECT_EQ(lBatch.token[1], 202);
  EXPECT_EQ(lBatch.token[2], 302);
  EXPECT_EQ(lBatch.logits[2], 1);
  // Slot 1 (still seq 1): remaining tokens 401, 501, 601 starting at pos 3.
  EXPECT_EQ(lBatch.seq_id[3][0], 1);
  EXPECT_EQ(lBatch.token[3], 401);
  EXPECT_EQ(lBatch.pos[3], 3);
  EXPECT_EQ(lBatch.token[4], 501);
  EXPECT_EQ(lBatch.token[5], 601);
  EXPECT_EQ(lBatch.pos[5], 5);
  EXPECT_EQ(lBatch.logits[5], 1);

  batcher.advance(result.chunkSize);
  EXPECT_TRUE(batcher.markFinished(seqId2));
  EXPECT_TRUE(batcher.markFinished(seqId1));
  auto finished12 = batcher.extractFinished();
  ASSERT_EQ(finished12.size(), 2);
  EXPECT_EQ(finished12[0].stopReason, StopReason::Finished);
  EXPECT_EQ(finished12[1].stopReason, StopReason::Finished);

  // === Step 5: Add request 3 (3 tokens) ===
  uint32_t seqId3 = 0;
  EXPECT_EQ(
      batcher.addRequest(
          std::vector<llama_token>(requests_[3].begin(), requests_[3].end()),
          seqId3),
      MultiRequestBatcher::AddStatus::Ok);
  EXPECT_EQ(seqId3, 0);

  // === Step 6: Batch 3 = 3 tokens (only req 3 active) ===
  result = batcher.fillBatch(batch);
  EXPECT_EQ(result.chunkSize, 3);
  EXPECT_EQ(result.numActiveSequences, 1);
  EXPECT_EQ(lBatch.seq_id[0][0], 0);
  EXPECT_EQ(lBatch.token[0], 103);
  EXPECT_EQ(lBatch.token[1], 203);
  EXPECT_EQ(lBatch.token[2], 303);
  EXPECT_EQ(lBatch.logits[2], 1);

  batcher.advance(result.chunkSize);
  EXPECT_TRUE(batcher.markFinished(seqId3));
  auto finished3 = batcher.extractFinished();
  ASSERT_EQ(finished3.size(), 1);
  EXPECT_EQ(finished3[0].stopReason, StopReason::Finished);
}

TEST_F(MultiRequestBatcherTest, ChunkSizePerSequencePrefillOnly) {
  const unsigned kMaxChunkSize = 3;
  const unsigned kMaxTokensPerSeq = 100;
  const size_t kBatchSize = 4;

  MultiRequestBatcher batcher(kMaxChunkSize, kMaxTokensPerSeq, kBatchSize);
  LlamaBatch batch(kMaxChunkSize * kBatchSize, 0, kBatchSize);

  uint32_t seqId0 = 0, seqId1 = 0, seqId2 = 0, seqId3 = 0;
  EXPECT_EQ(
      batcher.addRequest({100, 101}, seqId0),
      MultiRequestBatcher::AddStatus::Ok);
  EXPECT_EQ(
      batcher.addRequest({200, 201}, seqId1),
      MultiRequestBatcher::AddStatus::Ok);
  EXPECT_EQ(
      batcher.addRequest({300, 301}, seqId2),
      MultiRequestBatcher::AddStatus::Ok);
  EXPECT_EQ(
      batcher.addRequest({400, 401, 402, 403, 404}, seqId3),
      MultiRequestBatcher::AddStatus::Ok);

  // Batch 1: chunk = min(3, min(2,2,2,5)) = 2 → 2+2+2+2 = 8 tokens.
  // Sequences 0, 1, 2 finish (2/2 tokens). Seq 3 has 3 tokens left.
  auto result = batcher.fillBatch(batch);
  EXPECT_EQ(result.chunkSize, 2);
  EXPECT_EQ(result.numActiveSequences, 4);

  llama_batch& lBatch = *batch;
  EXPECT_EQ(lBatch.token[0], 100);
  EXPECT_EQ(lBatch.token[1], 101);
  EXPECT_EQ(lBatch.token[2], 200);
  EXPECT_EQ(lBatch.token[3], 201);
  EXPECT_EQ(lBatch.token[4], 300);
  EXPECT_EQ(lBatch.token[5], 301);
  EXPECT_EQ(lBatch.token[6], 400);
  EXPECT_EQ(lBatch.token[7], 401);
  EXPECT_EQ(lBatch.logits[1], 1); // seq 0 last
  EXPECT_EQ(lBatch.logits[3], 1); // seq 1 last
  EXPECT_EQ(lBatch.logits[5], 1); // seq 2 last
  EXPECT_EQ(lBatch.logits[7], 0); // seq 3 not last

  batcher.advance(result.chunkSize);

  EXPECT_TRUE(batcher.markFinished(seqId0));
  EXPECT_TRUE(batcher.markFinished(seqId1));
  EXPECT_TRUE(batcher.markFinished(seqId2));

  auto finished = batcher.extractFinished();
  ASSERT_EQ(finished.size(), 3);
  for (const auto& req : finished) {
    EXPECT_EQ(req.stopReason, StopReason::Finished);
  }

  // Batch 2: chunk = min(3, 3) = 3 → only seq 3 active, 3 tokens.
  result = batcher.fillBatch(batch);
  EXPECT_EQ(result.chunkSize, 3);
  EXPECT_EQ(result.numActiveSequences, 1);
  EXPECT_EQ(lBatch.seq_id[0][0], 3);
  EXPECT_EQ(lBatch.token[0], 402);
  EXPECT_EQ(lBatch.pos[0], 2);
  EXPECT_EQ(lBatch.token[1], 403);
  EXPECT_EQ(lBatch.token[2], 404);
  EXPECT_EQ(lBatch.pos[2], 4);
  EXPECT_EQ(lBatch.logits[2], 1);
}

TEST_F(MultiRequestBatcherTest, RejectsOversizedRequests) {
  MultiRequestBatcher batcher(2, 5, 4);

  uint32_t seqId = 0;
  EXPECT_EQ(
      batcher.addRequest({1, 2, 3, 4, 5}, seqId),
      MultiRequestBatcher::AddStatus::Ok);
  // 6 tokens > maxTokensPerSequence=5
  EXPECT_EQ(
      batcher.addRequest({1, 2, 3, 4, 5, 6}, seqId),
      MultiRequestBatcher::AddStatus::ErrTokensTooLarge);
  EXPECT_EQ(
      batcher.addRequest({}, seqId),
      MultiRequestBatcher::AddStatus::ErrEmptyTokens);
}

TEST(MultiRequestBatcherCapacityTest, FillBatchClampsChunkToCapacity) {
  constexpr unsigned maxChunkSize = 8;
  constexpr unsigned maxTokensPerSeq = 100;
  constexpr size_t batchSize = 4;
  constexpr int32_t batchCapacity = 4;

  MultiRequestBatcher batcher(maxChunkSize, maxTokensPerSeq, batchSize);
  LlamaBatch batch(batchCapacity, 0, batchSize);

  uint32_t seqId = 0;
  for (llama_token base : {10, 20, 30, 40}) {
    ASSERT_EQ(
        batcher.addRequest({base, base + 1, base + 2}, seqId),
        MultiRequestBatcher::AddStatus::Ok);
  }

  auto result = batcher.fillBatch(batch);

  EXPECT_EQ(result.numActiveSequences, 4u);
  EXPECT_EQ(result.chunkSize, 1u);
  EXPECT_EQ((*batch).n_tokens, batchCapacity);
}

TEST(
    MultiRequestBatcherCapacityTest, FillBatchHonoursMaxChunkSizeWhenCapAmple) {
  constexpr unsigned maxChunkSize = 2;
  constexpr unsigned maxTokensPerSeq = 100;
  constexpr size_t batchSize = 2;
  constexpr int32_t batchCapacity = 64;

  MultiRequestBatcher batcher(maxChunkSize, maxTokensPerSeq, batchSize);
  LlamaBatch batch(batchCapacity, 0, batchSize);

  uint32_t seqId = 0;
  ASSERT_EQ(
      batcher.addRequest({1, 2, 3}, seqId), MultiRequestBatcher::AddStatus::Ok);
  ASSERT_EQ(
      batcher.addRequest({4, 5, 6}, seqId), MultiRequestBatcher::AddStatus::Ok);

  auto result = batcher.fillBatch(batch);

  EXPECT_EQ(result.chunkSize, maxChunkSize);
  EXPECT_EQ((*batch).n_tokens, 4);
}

TEST(
    MultiRequestBatcherCapacityTest,
    FillBatchReturnsZeroWhenCapBelowActiveCount) {
  constexpr unsigned maxChunkSize = 4;
  constexpr unsigned maxTokensPerSeq = 100;
  constexpr size_t batchSize = 4;
  constexpr int32_t batchCapacity = 2;

  MultiRequestBatcher batcher(maxChunkSize, maxTokensPerSeq, batchSize);
  LlamaBatch batch(batchCapacity, 0, batchSize);

  uint32_t seqId = 0;
  for (llama_token base : {10, 20, 30, 40}) {
    ASSERT_EQ(
        batcher.addRequest({base, base + 1}, seqId),
        MultiRequestBatcher::AddStatus::Ok);
  }

  auto result = batcher.fillBatch(batch);

  EXPECT_EQ(result.numActiveSequences, 4u);
  EXPECT_EQ(result.chunkSize, 0u);
  EXPECT_EQ((*batch).n_tokens, 0);
}

TEST_F(MultiRequestBatcherTest, CancelFreesSlot) {
  MultiRequestBatcher batcher(10, 100, 2);

  uint32_t seqId0 = 0, seqId1 = 0;
  EXPECT_EQ(
      batcher.addRequest({1, 2, 3}, seqId0),
      MultiRequestBatcher::AddStatus::Ok);
  EXPECT_EQ(
      batcher.addRequest({4, 5, 6}, seqId1),
      MultiRequestBatcher::AddStatus::Ok);

  // Both slots full - cannot add a 3rd
  uint32_t seqIdReject = 0;
  EXPECT_EQ(
      batcher.addRequest({7, 8, 9}, seqIdReject),
      MultiRequestBatcher::AddStatus::ErrNoFreeSlot);

  // Cancel seq 0 - frees slot 0
  EXPECT_TRUE(batcher.cancel(seqId0));

  // Now can add new request, reusing freed slot 0
  uint32_t seqId2 = 0;
  EXPECT_EQ(
      batcher.addRequest({7, 8, 9}, seqId2),
      MultiRequestBatcher::AddStatus::Ok);
  EXPECT_EQ(seqId2, 0);

  // Canceling invalid seqId returns false
  EXPECT_FALSE(batcher.cancel(99));

  // Canceling already-cancelled slot returns false
  EXPECT_TRUE(batcher.cancel(seqId2));  // free slot 0 again
  EXPECT_FALSE(batcher.cancel(seqId2)); // already free
}

/// Memory hygiene: once a slot finishes prefill, pendingPrefillTokens must be
/// empty. Holding the prompt for the rest of the request is wasted memory.
TEST_F(MultiRequestBatcherTest, PendingPrefillTokensClearedAfterPrefill) {
  const unsigned kMaxChunkSize = 8;
  const unsigned kMaxTokensPerSeq = 100;
  const size_t kBatchSize = 2;

  MultiRequestBatcher batcher(kMaxChunkSize, kMaxTokensPerSeq, kBatchSize);
  LlamaBatch batch(kMaxChunkSize * kBatchSize, 0, kBatchSize);

  uint32_t seqId0 = 0;
  ASSERT_EQ(
      batcher.addRequest({10, 20, 30, 40, 50}, seqId0),
      MultiRequestBatcher::AddStatus::Ok);

  // Drive prefill in two chunks of 3 + 2 to confirm the buffer holds
  // remaining tokens during prefill, then drains to empty.
  auto result = batcher.fillBatch(batch);
  EXPECT_EQ(result.chunkSize, 5);
  mocked_llama_decode(*batch);
  batcher.advance(result.chunkSize);

  // Prefill drained: pendingPrefillTokens must be empty, capacity not held.
  // We mark finished then extract to inspect the Request.
  EXPECT_TRUE(batcher.markFinished(seqId0));
  auto finished = batcher.extractFinished();
  ASSERT_EQ(finished.size(), 1);
  EXPECT_EQ(finished[0].stopReason, StopReason::Finished);
  EXPECT_TRUE(finished[0].pendingPrefillTokens.empty());
  EXPECT_TRUE(finished[0].generatedTokens.empty()); // never sampled
}

/// Showcase end-to-end prefill + generation phase with mocked decoding.
///
/// Two sequences are prefilled, then generation continues for 3 tokens each.
/// The mock samples the next token as last_token * 10 (deterministic).
///
/// Phase 1 (prefill):
///   seq 0 input: [10, 20, 30] → after prefill, sampled token = 300
///   seq 1 input: [40, 50, 60] → after prefill, sampled token = 600
///
/// Phase 2 (generation): grow each sequence by feeding sampled tokens back
///   seq 0: 300 → sample 3000 → sample 30000 (3 generated tokens)
///   seq 1: 600 → sample 6000 → sample 60000
TEST_F(MultiRequestBatcherTest, PrefillAndGenerationWithMockedDecode) {
  const unsigned kMaxChunkSize = 8;
  const unsigned kMaxTokensPerSeq = 100;
  const size_t kBatchSize = 2;

  MultiRequestBatcher batcher(kMaxChunkSize, kMaxTokensPerSeq, kBatchSize);
  LlamaBatch batch(kMaxChunkSize * kBatchSize, 0, kBatchSize);

  // === Prefill ===
  uint32_t seqId0 = 0, seqId1 = 0;
  ASSERT_EQ(
      batcher.addRequest({10, 20, 30}, seqId0),
      MultiRequestBatcher::AddStatus::Ok);
  ASSERT_EQ(
      batcher.addRequest({40, 50, 60}, seqId1),
      MultiRequestBatcher::AddStatus::Ok);

  auto result = batcher.fillBatch(batch);
  EXPECT_EQ(result.chunkSize, 3);
  EXPECT_EQ(result.numActiveSequences, 2);

  // "Decode" the prefill batch
  mocked_llama_decode(*batch);
  batcher.advance(result.chunkSize);

  // Verify mock saw all 6 tokens
  EXPECT_EQ(mocked_decoded_[0].size(), 3);
  EXPECT_EQ(mocked_decoded_[1].size(), 3);
  EXPECT_EQ(mocked_decoded_[0].back(), 30);
  EXPECT_EQ(mocked_decoded_[1].back(), 60);
  // Last token of each sequence had logits requested
  EXPECT_EQ(mocked_logitsTokens_[0].size(), 1);
  EXPECT_EQ(mocked_logitsTokens_[1].size(), 1);

  // Prefill complete - slots are now in the GenerationIdle state. They stay
  // occupied until the caller markFinished() or sampleAndAppendIdle(), so
  // extractFinished() returns nothing here.
  EXPECT_EQ(batcher.extractFinished().size(), 0);

  // === Generation phase ===
  // Same Request objects (same seqId) live across all generation steps.
  // Each step: sampleAndAppendIdle (sample + push to generatedTokens) →
  // fillBatch (feed last sample) → llama_decode → advance.
  // After 3 generation steps: generatedTokens has 3 sampled tokens.

  for (int step = 0; step < 3; step++) {
    batcher.sampleAndAppendIdle([this](uint32_t seqId, int logitIdx) {
      return mocked_llama_sampler_sample(seqId, logitIdx);
    });

    auto genResult = batcher.fillBatch(batch);
    EXPECT_EQ(genResult.chunkSize, 1);
    EXPECT_EQ(genResult.numActiveSequences, 2);

    mocked_llama_decode(*batch);
    batcher.advance(genResult.chunkSize);

    // No request is finished yet - the caller hasn't marked them.
    EXPECT_EQ(batcher.extractFinished().size(), 0);
  }

  // End-of-stream: caller decides each sequence is done.
  EXPECT_TRUE(batcher.markFinished(seqId0));
  EXPECT_TRUE(batcher.markFinished(seqId1));
  auto finished = batcher.extractFinished();
  ASSERT_EQ(finished.size(), 2);
  EXPECT_EQ(finished[0].stopReason, StopReason::Finished);
  EXPECT_EQ(finished[1].stopReason, StopReason::Finished);

  // Each surviving Request now carries only the generated output (prompt is
  // dropped after prefill). Order in finished[] follows slot order
  // (seqId 0 then seqId 1).
  ASSERT_EQ(finished[0].seqId, seqId0);
  ASSERT_EQ(finished[1].seqId, seqId1);
  EXPECT_TRUE(finished[0].pendingPrefillTokens.empty());
  EXPECT_TRUE(finished[1].pendingPrefillTokens.empty());
  EXPECT_EQ(
      finished[0].generatedTokens,
      (std::vector<llama_token>{300, 3000, 30000}));
  EXPECT_EQ(
      finished[1].generatedTokens,
      (std::vector<llama_token>{600, 6000, 60000}));
}

/// Verifies cancel invokes the clear callback exactly when the slot was
/// actually occupied; canceling a free slot is a no-op on the KV side.
TEST_F(MultiRequestBatcherTest, CancelInvokesKvClearOnlyWhenSlotOccupied) {
  MultiRequestBatcher batcher(8, 100, 2);

  uint32_t seqId0 = 0;
  ASSERT_EQ(
      batcher.addRequest({1, 2, 3}, seqId0),
      MultiRequestBatcher::AddStatus::Ok);

  std::vector<uint32_t> cleared;
  auto kvClear = [&](uint32_t seqId) { cleared.push_back(seqId); };

  EXPECT_TRUE(batcher.cancel(seqId0, kvClear));
  ASSERT_EQ(cleared.size(), 1);
  EXPECT_EQ(cleared[0], seqId0);

  EXPECT_FALSE(batcher.cancel(seqId0, kvClear));
  EXPECT_EQ(cleared.size(), 1);

  EXPECT_FALSE(batcher.cancel(99, kvClear));
  EXPECT_EQ(cleared.size(), 1);
}

/// Once extractFinished frees a slot, the freed seqId is handed back to the
/// next addRequest, so callers can reuse the slot.
TEST_F(MultiRequestBatcherTest, ExtractFinishedFreesSlotForReuse) {
  MultiRequestBatcher batcher(8, 100, 2);

  uint32_t seqId0 = 0, seqId1 = 0;
  ASSERT_EQ(
      batcher.addRequest({1, 2, 3}, seqId0),
      MultiRequestBatcher::AddStatus::Ok);
  ASSERT_EQ(
      batcher.addRequest({4, 5, 6}, seqId1),
      MultiRequestBatcher::AddStatus::Ok);

  EXPECT_TRUE(batcher.markFinished(seqId0));

  EXPECT_EQ(batcher.extractFinished().size(), 1);

  uint32_t seqIdReuse = 99;
  ASSERT_EQ(
      batcher.addRequest({7, 8, 9}, seqIdReuse),
      MultiRequestBatcher::AddStatus::Ok);
  EXPECT_EQ(seqIdReuse, seqId0);
}

/// The batcher must hand the sampler the exact batch index where it set
/// logits=1 for that seqId. With heterogeneous prompts (one finishing
/// prefill, one still mid-prefill) only the ripe slot gets logits, and
/// only its sampler invocation must happen with a valid index.
TEST_F(MultiRequestBatcherTest, SamplerReceivesMatchingLogitIndex) {
  const unsigned kMaxChunkSize = 8;
  const unsigned kMaxTokensPerSeq = 100;
  const size_t kBatchSize = 2;

  MultiRequestBatcher batcher(kMaxChunkSize, kMaxTokensPerSeq, kBatchSize);
  LlamaBatch batch(kMaxChunkSize * kBatchSize, 0, kBatchSize);

  uint32_t seqId0 = 0, seqId1 = 0;
  ASSERT_EQ(
      batcher.addRequest({10, 20, 30}, seqId0),
      MultiRequestBatcher::AddStatus::Ok);
  ASSERT_EQ(
      batcher.addRequest({40, 50, 60}, seqId1),
      MultiRequestBatcher::AddStatus::Ok);

  auto result = batcher.fillBatch(batch);
  ASSERT_EQ(result.chunkSize, 3);
  mocked_llama_decode(*batch);
  batcher.advance(result.chunkSize);

  std::map<uint32_t, int> seenIndices;
  batcher.sampleAndAppendIdle([&](uint32_t seqId, int logitIdx) {
    seenIndices[seqId] = logitIdx;
    return mocked_llama_sampler_sample(seqId, logitIdx);
  });

  ASSERT_EQ(seenIndices.size(), 2);
  EXPECT_EQ(seenIndices[seqId0], 2);
  EXPECT_EQ(seenIndices[seqId1], 5);

  llama_batch& lBatch = *batch;
  EXPECT_EQ(lBatch.logits[seenIndices[seqId0]], 1);
  EXPECT_EQ(lBatch.logits[seenIndices[seqId1]], 1);
  EXPECT_EQ(
      static_cast<uint32_t>(lBatch.seq_id[seenIndices[seqId0]][0]), seqId0);
  EXPECT_EQ(
      static_cast<uint32_t>(lBatch.seq_id[seenIndices[seqId1]][0]), seqId1);
}

/// When a slot finishes prefill in chunk N but another slot is still
/// mid-prefill, only the ripe slot should be sampled. The mid-prefill
/// slot's logit index in the next fillBatch must be -1 (no logits yet),
/// so sampleAndAppendIdle must skip it entirely.
TEST_F(MultiRequestBatcherTest, NoSampleWhenChunkDoesNotFinishPrefill) {
  const unsigned kMaxChunkSize = 2;
  const unsigned kMaxTokensPerSeq = 100;
  const size_t kBatchSize = 2;

  MultiRequestBatcher batcher(kMaxChunkSize, kMaxTokensPerSeq, kBatchSize);
  LlamaBatch batch(kMaxChunkSize * kBatchSize, 0, kBatchSize);

  uint32_t seqId0 = 0, seqId1 = 0;
  ASSERT_EQ(
      batcher.addRequest({10, 20}, seqId0), MultiRequestBatcher::AddStatus::Ok);
  ASSERT_EQ(
      batcher.addRequest({40, 50, 60, 70}, seqId1),
      MultiRequestBatcher::AddStatus::Ok);

  auto result = batcher.fillBatch(batch);
  ASSERT_EQ(result.chunkSize, 2);
  mocked_llama_decode(*batch);
  batcher.advance(result.chunkSize);

  int sampleCount = 0;
  batcher.sampleAndAppendIdle([&](uint32_t seqId, int logitIdx) {
    sampleCount++;
    EXPECT_EQ(seqId, seqId0);
    EXPECT_GE(logitIdx, 0);
    return mocked_llama_sampler_sample(seqId, logitIdx);
  });
  EXPECT_EQ(sampleCount, 1);
}

TEST_F(MultiRequestBatcherTest, PromptSizeEqualsMaxFinishesImmediately) {
  const unsigned kMaxChunkSize = 8;
  const unsigned kMaxTokensPerSeq = 3;
  const size_t kBatchSize = 1;

  MultiRequestBatcher batcher(kMaxChunkSize, kMaxTokensPerSeq, kBatchSize);
  LlamaBatch batch(kMaxChunkSize * kBatchSize, 0, kBatchSize);

  uint32_t seqId = 0;
  // Prompt size (3) == maxTokensPerSequence (3)
  ASSERT_EQ(
      batcher.addRequest({10, 20, 30}, seqId),
      MultiRequestBatcher::AddStatus::Ok);

  auto result = batcher.fillBatch(batch);
  EXPECT_EQ(result.chunkSize, 3);
  batcher.advance(result.chunkSize);

  // Should be finished immediately after prefill due to limit
  auto finished = batcher.extractFinished();
  ASSERT_EQ(finished.size(), 1);
  EXPECT_EQ(finished[0].stopReason, StopReason::LimitReached);
  EXPECT_TRUE(finished[0].generatedTokens.empty());
}

TEST_F(MultiRequestBatcherTest, MarkAllFinishedWithDecodeError) {
  MultiRequestBatcher batcher(8, 100, 3);

  uint32_t seqId0 = 0, seqId1 = 0, seqId2 = 0;
  ASSERT_EQ(
      batcher.addRequest({1, 2, 3}, seqId0),
      MultiRequestBatcher::AddStatus::Ok);
  ASSERT_EQ(
      batcher.addRequest({4, 5, 6}, seqId1),
      MultiRequestBatcher::AddStatus::Ok);

  batcher.markAllFinished(StopReason::DecodeError);

  auto finished = batcher.extractFinished();
  ASSERT_EQ(finished.size(), 2);
  EXPECT_EQ(finished[0].stopReason, StopReason::DecodeError);
  EXPECT_EQ(finished[1].stopReason, StopReason::DecodeError);
}

TEST(MediaBarrierRequestTest, BarrierGatesFeedingAndCountsPositions) {
  constexpr unsigned kMaxTokens = 100;
  constexpr llama_pos kMediaPos = 4;
  PrefillPlan plan{
      .tokens = {10, 20, 30},
      .mediaBarriers = {
          {.afterTextTokens = 1, .mediaIndex = 7, .nPos = kMediaPos}}};
  Request req(0, std::move(plan), kMaxTokens);

  EXPECT_EQ(req.prefillTokenCount, 3u + static_cast<size_t>(kMediaPos));
  EXPECT_FALSE(req.isAwaitingMedia());
  EXPECT_TRUE(req.hasTokensToFeed());
  EXPECT_EQ(req.remainingToFeed(), 1u);

  req.prefillFedCount = 1;
  req.currentPos = 1;
  EXPECT_TRUE(req.isAwaitingMedia());
  EXPECT_FALSE(req.hasTokensToFeed());
  EXPECT_EQ(req.remainingToFeed(), 0u);
  EXPECT_FALSE(req.isPrefillComplete());

  // Pre-barrier chunk must never carry logits even though it drains
  // remainingToFeed.
  req.prefillFedCount = 0;
  EXPECT_FALSE(req.chunkConsumesAllUnfed(1));
}

TEST(MediaBarrierRequestTest, AddRequestAtValidatesPlan) {
  constexpr unsigned kMaxChunkSize = 8;
  constexpr unsigned kMaxTokensPerSeq = 10;
  constexpr size_t kBatchSize = 1;
  MultiRequestBatcher batcher(kMaxChunkSize, kMaxTokensPerSeq, kBatchSize);

  PrefillPlan unsorted{
      .tokens = {1, 2, 3},
      .mediaBarriers = {
          {.afterTextTokens = 2, .mediaIndex = 0, .nPos = 2},
          {.afterTextTokens = 1, .mediaIndex = 1, .nPos = 2}}};
  EXPECT_EQ(
      batcher.addRequestAt(0, std::move(unsorted)),
      MultiRequestBatcher::AddStatus::ErrInvalidPlan);

  PrefillPlan anchorPastEnd{
      .tokens = {1, 2},
      .mediaBarriers = {{.afterTextTokens = 3, .mediaIndex = 0, .nPos = 2}}};
  EXPECT_EQ(
      batcher.addRequestAt(0, std::move(anchorPastEnd)),
      MultiRequestBatcher::AddStatus::ErrInvalidPlan);

  // Media positions count against the per-sequence cap: 6 text + 5 media
  // > 10.
  PrefillPlan oversized{
      .tokens = {1, 2, 3, 4, 5, 6},
      .mediaBarriers = {{.afterTextTokens = 1, .mediaIndex = 0, .nPos = 5}}};
  EXPECT_EQ(
      batcher.addRequestAt(0, std::move(oversized)),
      MultiRequestBatcher::AddStatus::ErrTokensTooLarge);

  PrefillPlan fits{
      .tokens = {1, 2, 3, 4, 5},
      .mediaBarriers = {{.afterTextTokens = 1, .mediaIndex = 0, .nPos = 5}}};
  EXPECT_EQ(
      batcher.addRequestAt(0, std::move(fits)),
      MultiRequestBatcher::AddStatus::Ok);
}

/// M-RoPE media occupies fewer positions than KV cells. A plan whose
/// position span fits the per-sequence cap can still overrun the KV cache,
/// so admission must reject when the KV-cell total exceeds the cap even
/// though the position total does not.
TEST(MediaBarrierRequestTest, AddRequestAtRejectsKvCellOverflow) {
  constexpr unsigned kMaxChunkSize = 8;
  constexpr unsigned kMaxTokensPerSeq = 10;
  constexpr size_t kBatchSize = 1;
  MultiRequestBatcher batcher(kMaxChunkSize, kMaxTokensPerSeq, kBatchSize);

  // 3 text + 2 media positions = 5 <= 10, but 3 text + 9 media KV cells =
  // 12 > 10. Positions-only admission would wrongly accept this.
  PrefillPlan kvOverflow{
      .tokens = {1, 2, 3},
      .mediaBarriers = {
          {.afterTextTokens = 1, .mediaIndex = 0, .nPos = 2, .nKvTokens = 9}}};
  EXPECT_EQ(kvOverflow.totalPositions(), 5);
  EXPECT_EQ(kvOverflow.totalKvTokens(), 12);
  EXPECT_EQ(
      batcher.addRequestAt(0, std::move(kvOverflow)),
      MultiRequestBatcher::AddStatus::ErrTokensTooLarge);
}

/// A cache-loaded M-RoPE sequence restores more physical KV cells
/// (`cacheTokens`) than logical positions (`nPast`). Admission must size the
/// KV-cap check from the cell count, not the position count: a sequence whose
/// loaded cells sit near the cap can still be wrongly admitted if the check
/// measures from `initialPos` (comment-3437045337).
TEST(MediaBarrierRequestTest, AddRequestAtUsesKvCellsNotPositionsForCap) {
  constexpr unsigned kMaxChunkSize = 8;
  constexpr unsigned kMaxTokensPerSeq = 10;
  constexpr size_t kBatchSize = 1;
  MultiRequestBatcher batcher(kMaxChunkSize, kMaxTokensPerSeq, kBatchSize);

  // Restored cache: nPast (positions) = 2 but cacheTokens (cells) = 8.
  // Appending 3 text tokens keeps positions at 2 + 3 = 5 <= 10, but the
  // physical cells reach 8 + 3 = 11 > 10 and overrun the slot's KV cache.
  PrefillPlan plan{.tokens = {1, 2, 3}};
  EXPECT_EQ(plan.totalPositions(), 3);
  EXPECT_EQ(plan.totalKvTokens(), 3);
  EXPECT_EQ(
      batcher.addRequestAt(
          0,
          std::move(plan),
          /*initialPos=*/2,
          /*slideCapable=*/false,
          /*initialKvCells=*/8),
      MultiRequestBatcher::AddStatus::ErrTokensTooLarge)
      << "KV-CELL CAP HOLE: 8 loaded KV cells + 3 prompt tokens = 11 > "
      << kMaxTokensPerSeq
      << ", but admission sized the KV-cap check from the 2 logical positions "
         "(2 + 3 = 5) and admitted the request";
}

/// Full prefill flow with a mid-prompt media barrier:
/// feed text up to the barrier → slot blocks → completeMediaBarrier
/// resumes at the helper-provided position → trailing text carries the
/// prompt's only logits and fires onPrefillComplete.
TEST(MediaBarrierFlowTest, BarrierBlocksThenResumesAtNewPosition) {
  constexpr unsigned kMaxChunkSize = 8;
  constexpr unsigned kMaxTokensPerSeq = 100;
  constexpr size_t kBatchSize = 1;
  constexpr llama_pos kMediaPos = 4;
  MultiRequestBatcher batcher(kMaxChunkSize, kMaxTokensPerSeq, kBatchSize);
  LlamaBatch batch(kMaxChunkSize, 0, kBatchSize);

  PrefillPlan plan{
      .tokens = {10, 20, 30},
      .mediaBarriers = {
          {.afterTextTokens = 1, .mediaIndex = 7, .nPos = kMediaPos}}};
  ASSERT_EQ(
      batcher.addRequestAt(0, std::move(plan)),
      MultiRequestBatcher::AddStatus::Ok);

  EXPECT_FALSE(batcher.nextAwaitingMedia().has_value());

  auto result = batcher.fillBatch(batch);
  EXPECT_EQ(result.chunkSize, 1u);
  EXPECT_EQ(result.numActiveSequences, 1u);
  EXPECT_EQ((*batch).token[0], 10);
  EXPECT_EQ((*batch).logits[0], 0) << "pre-barrier token must not get logits";
  batcher.advance(result.chunkSize);

  const auto awaiting = batcher.nextAwaitingMedia();
  ASSERT_TRUE(awaiting.has_value());
  EXPECT_EQ(awaiting->seqId, 0u);
  EXPECT_EQ(awaiting->mediaIndex, 7u);
  EXPECT_EQ(awaiting->currentPos, 1);

  // While awaiting media the slot must not feed.
  result = batcher.fillBatch(batch);
  EXPECT_EQ(result.chunkSize, 0u);

  bool prefillCompleted = false;
  EXPECT_TRUE(batcher.completeMediaBarrier(
      0, awaiting->currentPos + kMediaPos, [&](uint32_t, llama_pos, size_t) {
        prefillCompleted = true;
      }));
  EXPECT_FALSE(prefillCompleted);
  EXPECT_FALSE(batcher.nextAwaitingMedia().has_value());

  llama_pos completedPos = -1;
  size_t completedCount = 0;
  result = batcher.fillBatch(batch);
  EXPECT_EQ(result.chunkSize, 2u);
  EXPECT_EQ((*batch).token[0], 20);
  EXPECT_EQ((*batch).token[1], 30);
  EXPECT_EQ((*batch).pos[0], 1 + kMediaPos);
  EXPECT_EQ((*batch).logits[1], 1) << "prompt end must carry logits";
  batcher.advance(result.chunkSize, [&](uint32_t, llama_pos pos, size_t count) {
    completedPos = pos;
    completedCount = count;
  });
  EXPECT_EQ(completedPos, 1 + kMediaPos + 2);
  EXPECT_EQ(completedCount, 3u + static_cast<size_t>(kMediaPos));
}

/// A media-blocked slot must not stall other slots: the text slot keeps
/// feeding while the media slot waits for its barrier.
TEST(MediaBarrierFlowTest, AwaitingMediaSlotDoesNotStallTextSlot) {
  constexpr unsigned kMaxChunkSize = 8;
  constexpr unsigned kMaxTokensPerSeq = 100;
  constexpr size_t kBatchSize = 2;
  MultiRequestBatcher batcher(kMaxChunkSize, kMaxTokensPerSeq, kBatchSize);
  LlamaBatch batch(kMaxChunkSize * kBatchSize, 0, kBatchSize);

  // Media-first prompt: the barrier anchors at token 0, so the slot is
  // blocked from the start.
  PrefillPlan mediaFirst{
      .tokens = {50, 60},
      .mediaBarriers = {{.afterTextTokens = 0, .mediaIndex = 0, .nPos = 3}}};
  ASSERT_EQ(
      batcher.addRequestAt(0, std::move(mediaFirst)),
      MultiRequestBatcher::AddStatus::Ok);
  ASSERT_EQ(
      batcher.addRequestAt(1, {100, 200, 300}),
      MultiRequestBatcher::AddStatus::Ok);

  auto result = batcher.fillBatch(batch);
  EXPECT_EQ(result.numActiveSequences, 1u)
      << "media-blocked slot must be excluded from the fill";
  EXPECT_EQ(result.chunkSize, 3u);
  EXPECT_EQ((*batch).seq_id[0][0], 1);

  const auto awaiting = batcher.nextAwaitingMedia();
  ASSERT_TRUE(awaiting.has_value());
  EXPECT_EQ(awaiting->seqId, 0u);
  EXPECT_EQ(awaiting->currentPos, 0);

  batcher.advance(result.chunkSize);
  EXPECT_TRUE(batcher.completeMediaBarrier(0, 3));

  result = batcher.fillBatch(batch);
  EXPECT_EQ(result.numActiveSequences, 1u);
  EXPECT_EQ(result.chunkSize, 2u);
  EXPECT_EQ((*batch).seq_id[0][0], 0);
  EXPECT_EQ((*batch).pos[0], 3);
}

/// A prefill that ends on a media barrier (prefill-only requests) must
/// complete through completeMediaBarrier, not advance().
TEST(MediaBarrierFlowTest, TrailingBarrierCompletesPrefill) {
  constexpr unsigned kMaxChunkSize = 8;
  constexpr unsigned kMaxTokensPerSeq = 100;
  constexpr size_t kBatchSize = 1;
  MultiRequestBatcher batcher(kMaxChunkSize, kMaxTokensPerSeq, kBatchSize);
  LlamaBatch batch(kMaxChunkSize, 0, kBatchSize);

  PrefillPlan plan{
      .tokens = {10},
      .mediaBarriers = {{.afterTextTokens = 1, .mediaIndex = 0, .nPos = 2}}};
  ASSERT_EQ(
      batcher.addRequestAt(0, std::move(plan)),
      MultiRequestBatcher::AddStatus::Ok);

  auto result = batcher.fillBatch(batch);
  EXPECT_EQ(result.chunkSize, 1u);
  batcher.advance(result.chunkSize);

  bool prefillCompleted = false;
  ASSERT_TRUE(batcher.nextAwaitingMedia().has_value());
  EXPECT_TRUE(batcher.completeMediaBarrier(
      0, 3, [&](uint32_t, llama_pos pos, size_t count) {
        prefillCompleted = true;
        EXPECT_EQ(pos, 3);
        EXPECT_EQ(count, 3u);
      }));
  EXPECT_TRUE(prefillCompleted);

  const Request* req = batcher.requestAt(0);
  ASSERT_NE(req, nullptr);
  EXPECT_TRUE(req->isPrefillComplete());
}

/// Consecutive media items (two barriers at the same anchor) are
/// serviced one at a time, in plan order.
TEST(MediaBarrierFlowTest, ConsecutiveBarriersServicedInOrder) {
  constexpr unsigned kMaxChunkSize = 8;
  constexpr unsigned kMaxTokensPerSeq = 100;
  constexpr size_t kBatchSize = 1;
  MultiRequestBatcher batcher(kMaxChunkSize, kMaxTokensPerSeq, kBatchSize);

  PrefillPlan plan{
      .tokens = {10},
      .mediaBarriers = {
          {.afterTextTokens = 0, .mediaIndex = 0, .nPos = 2},
          {.afterTextTokens = 0, .mediaIndex = 1, .nPos = 3}}};
  ASSERT_EQ(
      batcher.addRequestAt(0, std::move(plan)),
      MultiRequestBatcher::AddStatus::Ok);

  auto awaiting = batcher.nextAwaitingMedia();
  ASSERT_TRUE(awaiting.has_value());
  EXPECT_EQ(awaiting->mediaIndex, 0u);
  EXPECT_TRUE(batcher.completeMediaBarrier(0, 2));

  awaiting = batcher.nextAwaitingMedia();
  ASSERT_TRUE(awaiting.has_value());
  EXPECT_EQ(awaiting->mediaIndex, 1u);
  EXPECT_EQ(awaiting->currentPos, 2);
  EXPECT_TRUE(batcher.completeMediaBarrier(0, 5));

  EXPECT_FALSE(batcher.nextAwaitingMedia().has_value());
  const Request* req = batcher.requestAt(0);
  ASSERT_NE(req, nullptr);
  EXPECT_EQ(req->remainingToFeed(), 1u);
}
