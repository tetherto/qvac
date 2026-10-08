#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

#include <gtest/gtest.h>
#include <llama.h>

#include "model-interface/LlmContext.hpp"
#include "model-interface/MultiRequestBatcher.hpp"
#include "model-interface/SpeculativeRuntime.hpp"
#include "model-interface/SpeculativeSequence.hpp"

using namespace qvac_lib_inference_addon_llama::batching;
using namespace qvac_lib_inference_addon_llama::speculative;

namespace {

using ConfigMap = std::unordered_map<std::string, std::string>;

SpeculativeConfig parse(ConfigMap config) {
  return parseSpeculativeConfig(config);
}

} // namespace

TEST(SpeculativeConfigTest, AbsentKeysLeaveSpeculationOff) {
  ConfigMap config{{"ctx_size", "4096"}};
  const SpeculativeConfig parsed = parseSpeculativeConfig(config);
  EXPECT_FALSE(parsed.enabled());
  // Unrelated keys stay for llama.cpp's parser.
  EXPECT_EQ(config.count("ctx_size"), 1u);
}

TEST(SpeculativeConfigTest, ParsesDraftMtpAndConsumesKeys) {
  ConfigMap config{
      {"spec-type", "draft-mtp"},
      {"spec_draft_n_max", "5"},
      {"spec-draft-n-min", "2"},
      {"spec_draft_p_min", "0.25"}};
  const SpeculativeConfig parsed = parseSpeculativeConfig(config);
  EXPECT_TRUE(parsed.enabled());
  EXPECT_EQ(parsed.type, COMMON_SPECULATIVE_TYPE_DRAFT_MTP);
  EXPECT_EQ(parsed.draftNMax, 5);
  EXPECT_EQ(parsed.draftNMin, 2);
  ASSERT_TRUE(parsed.draftPMin.has_value());
  EXPECT_FLOAT_EQ(*parsed.draftPMin, 0.25F);
  // Consumed, so llama.cpp's parser never sees them.
  EXPECT_TRUE(config.empty());
}

TEST(SpeculativeConfigTest, ParsesDraftDflashWithItsDraftModel) {
  ConfigMap config{
      {"spec_type", "draft-dflash"},
      {"spec-draft-model", "/models/dflash.gguf"},
      {"spec-draft-n-max", "15"}};
  const SpeculativeConfig parsed = parseSpeculativeConfig(config);
  EXPECT_TRUE(parsed.enabled());
  EXPECT_EQ(parsed.type, COMMON_SPECULATIVE_TYPE_DRAFT_DFLASH);
  EXPECT_EQ(parsed.draftModelPath, "/models/dflash.gguf");
  EXPECT_EQ(parsed.draftNMax, 15);
  EXPECT_TRUE(config.empty());
}

TEST(SpeculativeConfigTest, DflashNeedsAnAbsoluteDraftModel) {
  EXPECT_THROW(parse({{"spec-type", "draft-dflash"}}), std::invalid_argument);
  EXPECT_THROW(
      parse(
          {{"spec-type", "draft-dflash"}, {"spec-draft-model", "dflash.gguf"}}),
      std::invalid_argument);
  EXPECT_THROW(
      parse({{"spec-type", "draft-dflash"}, {"spec_draft_model", ""}}),
      std::invalid_argument);
  // A draft model belongs to draft-dflash only.
  EXPECT_THROW(
      parse({{"spec-type", "draft-mtp"}, {"spec-draft-model", "/m/d.gguf"}}),
      std::invalid_argument);
  EXPECT_THROW(
      parse({{"spec-draft-model", "/m/d.gguf"}}), std::invalid_argument);
}

TEST(SpeculativeConfigTest, NoneIsAcceptedAndDisables) {
  EXPECT_FALSE(parse({{"spec_type", "none"}}).enabled());
}

TEST(SpeculativeConfigTest, RejectsOtherTypes) {
  EXPECT_THROW(parse({{"spec-type", "ngram-simple"}}), std::invalid_argument);
  EXPECT_THROW(parse({{"spec-type", "draft-simple"}}), std::invalid_argument);
  EXPECT_THROW(parse({{"spec-type", ""}}), std::invalid_argument);
}

TEST(SpeculativeConfigTest, RejectsBothSpellings) {
  EXPECT_THROW(
      parse({{"spec-type", "draft-mtp"}, {"spec_type", "draft-mtp"}}),
      std::invalid_argument);
}

TEST(SpeculativeConfigTest, RejectsOutOfRangeValues) {
  EXPECT_THROW(
      parse({{"spec-type", "draft-mtp"}, {"spec-draft-n-max", "0"}}),
      std::invalid_argument);
  EXPECT_THROW(
      parse(
          {{"spec-type", "draft-mtp"},
           {"spec-draft-n-max", std::to_string(MAX_SPEC_DRAFT_N_MAX + 1)}}),
      std::invalid_argument);
  EXPECT_THROW(
      parse({{"spec-type", "draft-mtp"}, {"spec-draft-n-max", "3x"}}),
      std::invalid_argument);
  EXPECT_THROW(
      parse({{"spec-type", "draft-mtp"}, {"spec-draft-p-min", "1.5"}}),
      std::invalid_argument);
  EXPECT_THROW(
      parse({{"spec-type", "draft-mtp"}, {"spec-draft-p-min", "abc"}}),
      std::invalid_argument);
  EXPECT_THROW(
      parse({{"spec-type", "draft-mtp"}, {"spec-draft-p-min", ""}}),
      std::invalid_argument);
}

TEST(SpeculativeConfigTest, RejectsMinAboveMax) {
  EXPECT_THROW(
      parse(
          {{"spec-type", "draft-mtp"},
           {"spec-draft-n-max", "2"},
           {"spec-draft-n-min", "3"}}),
      std::invalid_argument);
  // Against llama.cpp's default n_max when only n_min is given.
  const int32_t defaultNMax = common_params_speculative_draft{}.n_max;
  EXPECT_THROW(
      parse(
          {{"spec-type", "draft-mtp"},
           {"spec-draft-n-min", std::to_string(defaultNMax + 1)}}),
      std::invalid_argument);
}

TEST(SpeculativeConfigTest, DraftOptionsNeedAType) {
  EXPECT_THROW(parse({{"spec-draft-n-max", "4"}}), std::invalid_argument);
  EXPECT_THROW(
      parse({{"spec-type", "none"}, {"spec-draft-p-min", "0.5"}}),
      std::invalid_argument);
}

TEST(SpeculativeConfigTest, ApplySizesOutputsLikeLlamaServer) {
  common_params params;
  params.n_batch = 2048;
  params.n_parallel = 4;
  applySpeculativeConfig(
      SpeculativeConfig{
          .type = COMMON_SPECULATIVE_TYPE_DRAFT_MTP, .draftNMax = 3},
      params);
  ASSERT_EQ(params.speculative.types.size(), 1u);
  EXPECT_EQ(params.speculative.types[0], COMMON_SPECULATIVE_TYPE_DRAFT_MTP);
  EXPECT_EQ(params.speculative.draft.n_max, 3);
  // A verification step reads the sample plus every draft token, per slot.
  EXPECT_EQ(params.n_outputs_max_per_seq, 4);
  EXPECT_EQ(params.n_outputs_max, 16);
  // MTP keeps recurrent-state snapshots for rolling back rejected drafts.
  EXPECT_EQ(params.speculative.need_n_rs_seq(), 3u);
}

TEST(SpeculativeConfigTest, ApplyLeavesParamsAloneWhenOff) {
  common_params params;
  const auto outputsMax = params.n_outputs_max;
  const auto outputsPerSeq = params.n_outputs_max_per_seq;
  applySpeculativeConfig(SpeculativeConfig{}, params);
  ASSERT_EQ(params.speculative.types.size(), 1u);
  EXPECT_EQ(params.speculative.types[0], COMMON_SPECULATIVE_TYPE_NONE);
  EXPECT_EQ(params.n_outputs_max, outputsMax);
  EXPECT_EQ(params.n_outputs_max_per_seq, outputsPerSeq);
}

TEST(SpeculativeConfigTest, FitCountsTheMtpContextLikeTheLoad) {
  common_params params;
  EXPECT_EQ(SpeculativeFitModel::create(params), nullptr);

  params.model.path = "/models/target.gguf";
  applySpeculativeConfig(
      SpeculativeConfig{.type = COMMON_SPECULATIVE_TYPE_DRAFT_MTP}, params);
  const auto fit = SpeculativeFitModel::create(params);
  ASSERT_NE(fit, nullptr);
  const common_fit_extra_model* extra = fit->extra();
  // The MTP context runs on the target's own weights.
  EXPECT_TRUE(extra->shares_model);
  EXPECT_STREQ(extra->path_model, "/models/target.gguf");
  EXPECT_EQ(extra->cparams->ctx_type, LLAMA_CONTEXT_TYPE_MTP);
  EXPECT_EQ(extra->cparams->n_rs_seq, 0u);
}

TEST(SpeculativeConfigTest, ApplyPlacesTheDraftModelLikeTheTarget) {
  common_params params;
  params.n_gpu_layers = 12;
  applySpeculativeConfig(
      SpeculativeConfig{
          .type = COMMON_SPECULATIVE_TYPE_DRAFT_DFLASH,
          .draftModelPath = "/models/dflash.gguf"},
      params);
  ASSERT_EQ(params.speculative.types.size(), 1u);
  EXPECT_EQ(params.speculative.types[0], COMMON_SPECULATIVE_TYPE_DRAFT_DFLASH);
  EXPECT_TRUE(params.speculative.has_dft());
  EXPECT_EQ(params.speculative.draft.mparams.path, "/models/dflash.gguf");
  EXPECT_EQ(params.speculative.draft.n_gpu_layers, 12);
}

TEST(SpeculativeConfigTest, FitCountsTheDflashModelOnItsOwn) {
  common_params params;
  params.model.path = "/models/target.gguf";
  applySpeculativeConfig(
      SpeculativeConfig{
          .type = COMMON_SPECULATIVE_TYPE_DRAFT_DFLASH,
          .draftModelPath = "/models/dflash.gguf"},
      params);
  const auto fit = SpeculativeFitModel::create(params);
  ASSERT_NE(fit, nullptr);
  const common_fit_extra_model* extra = fit->extra();
  // The draft model has weights of its own and a plain context.
  EXPECT_FALSE(extra->shares_model);
  EXPECT_STREQ(extra->path_model, "/models/dflash.gguf");
  EXPECT_NE(extra->cparams->ctx_type, LLAMA_CONTEXT_TYPE_MTP);
  EXPECT_EQ(extra->cparams->n_rs_seq, 0u);
}

TEST(SpeculativeSequenceTest, MaxDraftLeavesRoomAndRespectsBudget) {
  // Window: two positions stay free (the sample and one spare).
  EXPECT_EQ(SpeculativeSequence::maxDraft(100, 90, -1), 8);
  EXPECT_EQ(SpeculativeSequence::maxDraft(100, 98, -1), 0);
  // Budget: the sample takes one of the remaining tokens.
  EXPECT_EQ(SpeculativeSequence::maxDraft(100, 10, 4), 3);
  EXPECT_EQ(SpeculativeSequence::maxDraft(100, 10, 1), 0);
}

TEST(SpeculativeSequenceTest, UnboundSequenceNeverDrafts) {
  SpeculativeSequence sequence;
  EXPECT_FALSE(sequence.enabled());
  EXPECT_FALSE(sequence.prepareDraft(4, 10, 42, {}));
  EXPECT_FALSE(sequence.hasDraft());
}

namespace {

/// One slot at the generation phase: prompt {10, 11} decoded, first token
/// 50 sampled and not fed yet.
struct GeneratingSlot {
  static constexpr unsigned kMaxChunk = 8;
  static constexpr unsigned kMaxTokens = 100;

  MultiRequestBatcher batcher{kMaxChunk, kMaxTokens, 2};
  LlamaBatch batch{kMaxChunk * 2, 0, 2};
  uint32_t seqId = 0;

  GeneratingSlot() {
    EXPECT_EQ(
        batcher.addRequest({10, 11}, seqId),
        MultiRequestBatcher::AddStatus::Ok);
    EXPECT_EQ(batcher.fillBatch(batch).totalTokens, 2u);
    batcher.advance();
    batcher.sampleAndAppendIdle([](uint32_t, int) { return 50; });
  }

  [[nodiscard]] const Request& req() const { return *batcher.requestAt(seqId); }
};

} // namespace

TEST(SpeculativeBatcherTest, FeedsSampleAndDraftWithLogitsOnEach) {
  GeneratingSlot slot;
  slot.batcher.setDraft(slot.seqId, {51, 52, 53});
  const auto result = slot.batcher.fillBatch(slot.batch);
  EXPECT_EQ(result.totalTokens, 4u);
  EXPECT_EQ(result.decodeTokens, 4u);
  EXPECT_FALSE(slot.batcher.draftDropped(slot.seqId));

  const llama_batch& lBatch = *slot.batch;
  ASSERT_EQ(lBatch.n_tokens, 4);
  const std::vector<llama_token> expected{50, 51, 52, 53};
  for (int i = 0; i < 4; i++) {
    EXPECT_EQ(lBatch.token[i], expected[i]);
    EXPECT_EQ(lBatch.pos[i], 2 + i);
    EXPECT_EQ(lBatch.logits[i], 1);
    EXPECT_EQ(lBatch.seq_id[i][0], static_cast<llama_seq_id>(slot.seqId));
  }
  EXPECT_EQ(slot.req().draftLogitStart, 0);
  EXPECT_EQ(slot.req().draftBasePos, 2);
}

TEST(SpeculativeBatcherTest, VerifiedTokensAreCountedAndLastIsUnfed) {
  GeneratingSlot slot;
  slot.batcher.setDraft(slot.seqId, {51, 52, 53});
  (void)slot.batcher.fillBatch(slot.batch);
  slot.batcher.advance();
  EXPECT_EQ(slot.req().currentPos, 6);

  int seenFirst = -1;
  llama_pos seenBase = -1;
  slot.batcher.verifyDrafted([&](uint32_t, int first, llama_pos base) {
    seenFirst = first;
    seenBase = base;
    // Two drafts accepted plus the target's own next token; the rejected
    // third draft is trimmed, so memory ends after 50, 51, 52.
    return MultiRequestBatcher::DraftOutcome{
        .newPos = 5, .tokens = {51, 52, 60}};
  });
  EXPECT_EQ(seenFirst, 0);
  EXPECT_EQ(seenBase, 2);
  const Request& req = slot.req();
  EXPECT_EQ(req.currentPos, 5);
  EXPECT_EQ(req.generatedTokens, (std::vector<llama_token>{50, 51, 52, 60}));
  EXPECT_TRUE(req.hasUnfedSample);
  EXPECT_TRUE(req.draftTokens.empty());
  EXPECT_EQ(req.draftLogitStart, -1);

  // The verified slot is not sampled again; the next step feeds 60 alone.
  int sampled = 0;
  slot.batcher.sampleAndAppendIdle([&](uint32_t, int) {
    ++sampled;
    return 70;
  });
  EXPECT_EQ(sampled, 0);
  (void)slot.batcher.fillBatch(slot.batch);
  ASSERT_EQ((*slot.batch).n_tokens, 1);
  EXPECT_EQ((*slot.batch).token[0], 60);
  EXPECT_EQ((*slot.batch).pos[0], 5);
}

TEST(SpeculativeBatcherTest, ReplayFeedsTheSampleAndDraftAgain) {
  GeneratingSlot slot;
  slot.batcher.setDraft(slot.seqId, {51, 52});
  (void)slot.batcher.fillBatch(slot.batch);
  slot.batcher.advance();
  slot.batcher.verifyDrafted([](uint32_t, int, llama_pos base) {
    return MultiRequestBatcher::DraftOutcome{
        .replay = true, .draft = {51, 61}, .newPos = base};
  });
  const Request& req = slot.req();
  EXPECT_EQ(req.currentPos, 2);
  EXPECT_EQ(req.generatedTokens, (std::vector<llama_token>{50}));
  EXPECT_TRUE(req.hasUnfedSample);

  (void)slot.batcher.fillBatch(slot.batch);
  const llama_batch& lBatch = *slot.batch;
  ASSERT_EQ(lBatch.n_tokens, 3);
  EXPECT_EQ(lBatch.token[0], 50);
  EXPECT_EQ(lBatch.token[1], 51);
  EXPECT_EQ(lBatch.token[2], 61);
  EXPECT_EQ(lBatch.pos[0], 2);
}

TEST(SpeculativeBatcherTest, TerminalTokenIsNotCountedUnlessPredictionLimit) {
  {
    GeneratingSlot slot;
    slot.batcher.setDraft(slot.seqId, {51, 52});
    (void)slot.batcher.fillBatch(slot.batch);
    slot.batcher.advance();
    slot.batcher.verifyDrafted([](uint32_t, int, llama_pos) {
      return MultiRequestBatcher::DraftOutcome{
          .newPos = 4, .tokens = {51, 2}, .finished = true};
    });
    EXPECT_EQ(slot.req().generatedTokens, (std::vector<llama_token>{50, 51}));
    EXPECT_EQ(slot.req().stopReason, StopReason::Finished);
    EXPECT_FALSE(slot.req().hasUnfedSample);
  }
  {
    GeneratingSlot slot;
    slot.batcher.setDraft(slot.seqId, {51, 52});
    (void)slot.batcher.fillBatch(slot.batch);
    slot.batcher.advance();
    slot.batcher.verifyDrafted([](uint32_t, int, llama_pos) {
      return MultiRequestBatcher::DraftOutcome{
          .newPos = 4,
          .tokens = {51, 52},
          .finished = true,
          .stopReason = StopReason::PredictionLimit};
    });
    EXPECT_EQ(
        slot.req().generatedTokens, (std::vector<llama_token>{50, 51, 52}));
    EXPECT_EQ(slot.req().stopReason, StopReason::PredictionLimit);
  }
}

TEST(SpeculativeBatcherTest, DraftWithoutRoomIsDropped) {
  constexpr unsigned kMaxChunk = 8;
  MultiRequestBatcher batcher(kMaxChunk, 100, 2);
  // Room for three tokens: both slots get at least one, the draft does not
  // fit whole.
  LlamaBatch prefillBatch(kMaxChunk * 2, 0, 2);
  LlamaBatch tightBatch(3, 0, 2);
  uint32_t seqA = 0;
  uint32_t seqB = 0;
  ASSERT_EQ(batcher.addRequest({10}, seqA), MultiRequestBatcher::AddStatus::Ok);
  ASSERT_EQ(batcher.addRequest({20}, seqB), MultiRequestBatcher::AddStatus::Ok);
  (void)batcher.fillBatch(prefillBatch);
  batcher.advance();
  batcher.sampleAndAppendIdle(
      [](uint32_t seqId, int) { return static_cast<llama_token>(50 + seqId); });

  batcher.setDraft(seqA, {60, 61, 62});
  const auto result = batcher.fillBatch(tightBatch);
  EXPECT_TRUE(batcher.draftDropped(seqA));
  EXPECT_FALSE(batcher.draftDropped(seqB));
  EXPECT_EQ(batcher.chunkSizeFor(seqA), 1u);
  EXPECT_EQ(batcher.chunkSizeFor(seqB), 1u);
  EXPECT_EQ(result.totalTokens, 2u);
  EXPECT_EQ(result.decodeTokens, 2u);
  EXPECT_EQ(batcher.requestAt(seqA)->draftLogitStart, -1);
  EXPECT_TRUE(batcher.requestAt(seqA)->draftTokens.empty());
}

TEST(SpeculativeStatsTest, AddSumsCountersAndPositions) {
  SpeculativeStats total;
  SpeculativeStats one{
      .draftTokens = 6,
      .draftAccepted = 4,
      .verifySteps = 2,
      .acceptedPerPos = {2, 2}};
  SpeculativeStats two{
      .draftTokens = 3,
      .draftAccepted = 3,
      .verifySteps = 1,
      .acceptedPerPos = {1, 1, 1}};
  total.add(one);
  total.add(two);
  EXPECT_EQ(total.draftTokens, 9u);
  EXPECT_EQ(total.draftAccepted, 7u);
  EXPECT_EQ(total.verifySteps, 3u);
  EXPECT_EQ(total.acceptedPerPos, (std::vector<uint64_t>{3, 3, 1}));
}
