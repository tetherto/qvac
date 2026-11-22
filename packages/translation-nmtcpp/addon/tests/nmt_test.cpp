#include <cmath>
#include <set>
#include <vector>

#include <gtest/gtest.h>

#include "model-interface/nmt.hpp"
#include "model-interface/nmt_state_backend.hpp"

class Nmt : public ::testing::Test {
protected:
  // Constants to avoid magic numbers in tests
  static constexpr int64_t BEAM_ZERO = 0;
  static constexpr int64_t BEAM_VALID = 8;
  static constexpr int64_t BEAM_NEGATIVE = -1;

  static constexpr double LENGTH_PENALTY_MIN = 0.0;
  static constexpr double LENGTH_PENALTY_VALID = 1.5;
  static constexpr double TINY_NEGATIVE = -0.001;

  static constexpr int64_t MAX_LENGTH_MIN = 0;
  static constexpr int64_t MAX_LENGTH_MAX = 512;
  static constexpr int64_t MAX_LENGTH_BELOW_MIN = -1;
  static constexpr int64_t MAX_LENGTH_ABOVE_MAX = 513;

  static constexpr double REP_PENALTY_MIN = 0.0;
  static constexpr double REP_PENALTY_MAX = 2.0;
  static constexpr double REP_PENALTY_SLIGHTLY_ABOVE = 2.0001;
  static constexpr double SMALL_NEGATIVE = -0.1;

  static constexpr int64_t NO_REPEAT_NGRAM_MIN = 0;
  static constexpr int64_t NO_REPEAT_NGRAM_MAX = 10;
  static constexpr int64_t NO_REPEAT_NGRAM_BELOW_MIN = -1;
  static constexpr int64_t NO_REPEAT_NGRAM_ABOVE_MAX = 11;

  static constexpr double TEMPERATURE_MIN = 0.0;
  static constexpr double TEMPERATURE_MAX = 2.0;
  static constexpr double TEMPERATURE_SLIGHTLY_ABOVE = 2.0001;

  static constexpr int VOCAB_SIZE = 100;
  static constexpr int64_t TOP_K_MIN = 0;
  static constexpr int64_t TOP_K_MAX = VOCAB_SIZE;
  static constexpr int64_t TOP_K_BELOW_MIN = -1;
  static constexpr int64_t TOP_K_ABOVE_MAX = VOCAB_SIZE + 1;

  static constexpr double TOP_P_MIN = 0.0;
  static constexpr double TOP_P_MAX = 1.0;
  static constexpr double TOP_P_SLIGHTLY_ABOVE = 1.0001;

  static constexpr int TOKENS_TO_PROCESS_DEFAULT = 512;

  static nmt_context makeCtx() {
    nmt_context ctx;
    return ctx;
  }
};

TEST_F(Nmt, SetBeamSize_ValidAndInvalid) {
  auto ctx = makeCtx();
  // valid: 0 and positive
  EXPECT_NO_THROW(ctx.setBeamSize(BEAM_ZERO));
  EXPECT_EQ(ctx.model.config.beam_size, BEAM_ZERO);
  EXPECT_NO_THROW(ctx.setBeamSize(BEAM_VALID));
  EXPECT_EQ(ctx.model.config.beam_size, BEAM_VALID);
  // invalid: negative
  EXPECT_THROW(ctx.setBeamSize(BEAM_NEGATIVE), std::runtime_error);
}

TEST_F(Nmt, SetLengthPenalty_ValidAndInvalid) {
  auto ctx = makeCtx();
  EXPECT_NO_THROW(ctx.setLengthPenalty(LENGTH_PENALTY_MIN));
  EXPECT_DOUBLE_EQ(ctx.model.config.length_penalty, LENGTH_PENALTY_MIN);
  EXPECT_NO_THROW(ctx.setLengthPenalty(LENGTH_PENALTY_VALID));
  EXPECT_DOUBLE_EQ(ctx.model.config.length_penalty, LENGTH_PENALTY_VALID);
  EXPECT_THROW(ctx.setLengthPenalty(TINY_NEGATIVE), std::runtime_error);
}

TEST_F(Nmt, SetMaxLength_ValidAndInvalid) {
  auto ctx = makeCtx();
  EXPECT_NO_THROW(ctx.setMaxLength(MAX_LENGTH_MIN));
  EXPECT_EQ(ctx.model.config.max_length, MAX_LENGTH_MIN);
  EXPECT_NO_THROW(ctx.setMaxLength(MAX_LENGTH_MAX));
  EXPECT_EQ(ctx.model.config.max_length, MAX_LENGTH_MAX);
  EXPECT_THROW(ctx.setMaxLength(MAX_LENGTH_BELOW_MIN), std::runtime_error);
  EXPECT_THROW(ctx.setMaxLength(MAX_LENGTH_ABOVE_MAX), std::runtime_error);
}

TEST_F(Nmt, SetRepetitionPenalty_ValidAndInvalid) {
  auto ctx = makeCtx();
  EXPECT_NO_THROW(ctx.setRepetitionPenalty(REP_PENALTY_MIN));
  EXPECT_DOUBLE_EQ(ctx.model.config.repetition_penalty, REP_PENALTY_MIN);
  EXPECT_NO_THROW(ctx.setRepetitionPenalty(REP_PENALTY_MAX));
  EXPECT_DOUBLE_EQ(ctx.model.config.repetition_penalty, REP_PENALTY_MAX);
  EXPECT_THROW(ctx.setRepetitionPenalty(SMALL_NEGATIVE), std::runtime_error);
  EXPECT_THROW(
      ctx.setRepetitionPenalty(REP_PENALTY_SLIGHTLY_ABOVE), std::runtime_error);
}

TEST_F(Nmt, SetNoRepeatNgramSize_ValidAndInvalid) {
  auto ctx = makeCtx();
  EXPECT_NO_THROW(ctx.setNoRepeatNgramSize(NO_REPEAT_NGRAM_MIN));
  EXPECT_EQ(ctx.model.config.no_repeat_ngram_size, NO_REPEAT_NGRAM_MIN);
  EXPECT_NO_THROW(ctx.setNoRepeatNgramSize(NO_REPEAT_NGRAM_MAX));
  EXPECT_EQ(ctx.model.config.no_repeat_ngram_size, NO_REPEAT_NGRAM_MAX);
  EXPECT_THROW(
      ctx.setNoRepeatNgramSize(NO_REPEAT_NGRAM_BELOW_MIN), std::runtime_error);
  EXPECT_THROW(
      ctx.setNoRepeatNgramSize(NO_REPEAT_NGRAM_ABOVE_MAX), std::runtime_error);
}

TEST_F(Nmt, SetTemperature_ValidAndInvalid) {
  auto ctx = makeCtx();
  EXPECT_NO_THROW(ctx.setTemperature(TEMPERATURE_MIN));
  EXPECT_DOUBLE_EQ(ctx.model.config.temperature, TEMPERATURE_MIN);
  EXPECT_NO_THROW(ctx.setTemperature(TEMPERATURE_MAX));
  EXPECT_DOUBLE_EQ(ctx.model.config.temperature, TEMPERATURE_MAX);
  EXPECT_THROW(ctx.setTemperature(TINY_NEGATIVE), std::runtime_error);
  EXPECT_THROW(
      ctx.setTemperature(TEMPERATURE_SLIGHTLY_ABOVE), std::runtime_error);
}

TEST_F(Nmt, SetTopK_ValidAndInvalid_DependsOnVocabSize) {
  auto ctx = makeCtx();
  // Simulate a vocab of size 100
  for (int i = 0; i < VOCAB_SIZE; ++i) {
    ctx.vocab.src_token_to_id[std::to_string(i)] = i;
  }

  EXPECT_NO_THROW(ctx.setTopK(TOP_K_MIN));
  EXPECT_EQ(ctx.model.config.top_k, TOP_K_MIN);
  EXPECT_NO_THROW(ctx.setTopK(TOP_K_MAX));
  EXPECT_EQ(ctx.model.config.top_k, TOP_K_MAX);
  EXPECT_THROW(ctx.setTopK(TOP_K_BELOW_MIN), std::runtime_error);
  EXPECT_THROW(ctx.setTopK(TOP_K_ABOVE_MAX), std::runtime_error);
}

TEST_F(Nmt, SetTopP_ValidAndInvalid) {
  auto ctx = makeCtx();
  EXPECT_NO_THROW(ctx.setTopP(TOP_P_MIN));
  EXPECT_DOUBLE_EQ(ctx.model.config.top_p, TOP_P_MIN);
  EXPECT_NO_THROW(ctx.setTopP(TOP_P_MAX));
  EXPECT_DOUBLE_EQ(ctx.model.config.top_p, TOP_P_MAX);
  EXPECT_THROW(ctx.setTopP(TINY_NEGATIVE), std::runtime_error);
  EXPECT_THROW(ctx.setTopP(TOP_P_SLIGHTLY_ABOVE), std::runtime_error);
}

TEST_F(Nmt, KvCache_Defaults) {
  nmt_kv_cache kvCache{};
  EXPECT_EQ(kvCache.head, 0U);
  EXPECT_EQ(kvCache.size, 0U);
  EXPECT_EQ(kvCache.n, 0U);
  EXPECT_TRUE(kvCache.cells.empty());
  EXPECT_EQ(kvCache.k, nullptr);
  EXPECT_EQ(kvCache.v, nullptr);
  EXPECT_EQ(kvCache.buffer, nullptr);
  EXPECT_TRUE(kvCache.ctx_buf.empty());
}

TEST_F(Nmt, State_Defaults) {
  nmt_state state{};

  // Timers
  EXPECT_EQ(state.t_sample_us, 0);
  EXPECT_EQ(state.t_encode_us, 0);
  EXPECT_EQ(state.t_decode_us, 0);
  EXPECT_EQ(state.t_batchd_us, 0);
  EXPECT_EQ(state.t_prompt_us, 0);
  EXPECT_EQ(state.t_mel_us, 0);

  // Counters
  EXPECT_EQ(state.n_sample, 0);
  EXPECT_EQ(state.n_encode, 0);
  EXPECT_EQ(state.n_decode, 0);
  EXPECT_EQ(state.n_batchd, 0);
  EXPECT_EQ(state.n_prompt, 0);
  EXPECT_EQ(state.n_fail_p, 0);
  EXPECT_EQ(state.n_fail_h, 0);

  // KV caches and decoders meta
  EXPECT_EQ(state.kv_self_n_dec, 0);

  // Batch defaults
  EXPECT_EQ(state.batch.n_tokens, 0);
  EXPECT_EQ(state.batch.token, nullptr);
  EXPECT_EQ(state.batch.pos, nullptr);
  EXPECT_EQ(state.batch.n_seq_id, nullptr);
  EXPECT_EQ(state.batch.seq_id, nullptr);
  EXPECT_EQ(state.batch.logits, nullptr);

  // Pointers and buffers
  EXPECT_EQ(state.input_embeddings, nullptr);
  EXPECT_EQ(state.logits_tensor, nullptr);
  EXPECT_EQ(state.embd_enc, nullptr);

  EXPECT_TRUE(state.encoder_result.empty());
  EXPECT_TRUE(state.inp_mel.empty());
  EXPECT_TRUE(state.inp_mask.empty());
  EXPECT_TRUE(state.logits.empty());
  EXPECT_TRUE(state.prompt_past.empty());

  EXPECT_TRUE(state.backends.empty());

  // Timestamps
  EXPECT_EQ(state.t_beg, 0);
  EXPECT_EQ(state.t_last, 0);

  // Attention diagnostics
  EXPECT_EQ(state.aheads_cross_QKs, nullptr);
  EXPECT_TRUE(state.aheads_cross_QKs_data.empty());

  // Experimental settings
  EXPECT_EQ(state.exp_n_encoder_ctx, 0);

  // Tokens and language
  EXPECT_TRUE(state.text_tokens.empty());
  EXPECT_EQ(state.text_tokens_begin, 0);
  EXPECT_EQ(state.tokens_to_process, Nmt::TOKENS_TO_PROCESS_DEFAULT);
  EXPECT_TRUE(state.decoder_inputs.empty());
  EXPECT_EQ(state.lang_id, 0);

  // Result buffer
  EXPECT_TRUE(state.result_all.empty());

  // Energy / speech
  EXPECT_TRUE(state.energy.empty());
  EXPECT_FLOAT_EQ(state.no_speech_prob, 0.0F);
}

namespace {

// A beam-search cache after one step: cell 0 holds BOS for beams 0, 1 and 2;
// cells 1, 2 and 3 hold the first token of beams 0, 1 and 2.
nmt_kv_cache makeBeamCache() {
  nmt_kv_cache cache;
  cache.size = 8;
  cache.cells.resize(cache.size);
  cache.cells[0].pos = 0;
  cache.cells[0].seq_id = {0, 1, 2};
  cache.cells[1].pos = 1;
  cache.cells[1].seq_id = {0};
  cache.cells[2].pos = 1;
  cache.cells[2].seq_id = {1};
  cache.cells[3].pos = 1;
  cache.cells[3].seq_id = {2};
  cache.head = 4;
  return cache;
}

} // namespace

TEST(NmtBeamKvCache, ReassignSharesParentWithChildrenAndFreesDroppedParent) {
  nmt_kv_cache cache = makeBeamCache();

  // Beam 0 has two children, beam 1 is dropped, beam 2 continues.
  nmtKvCacheReassignSeqs(cache, {0, 0, 2}, 3);

  EXPECT_EQ(cache.cells[0].seq_id, (std::set<nmt_seq_id>{0, 1, 2}));
  EXPECT_EQ(cache.cells[1].seq_id, (std::set<nmt_seq_id>{0, 1}));
  EXPECT_TRUE(cache.cells[2].seq_id.empty());
  EXPECT_EQ(cache.cells[2].pos, -1);
  EXPECT_EQ(cache.cells[3].seq_id, (std::set<nmt_seq_id>{2}));
  EXPECT_EQ(cache.cells[3].pos, 1);
  // The freed cell can be reused by the next step.
  EXPECT_EQ(cache.head, 2U);
}

TEST(NmtBeamKvCache, ReassignKeepsSharedCellsUntilLastUserIsRemoved) {
  nmt_kv_cache cache = makeBeamCache();

  // Beams 0 and 2 finish; only beam 1 continues.
  nmtKvCacheReassignSeqs(cache, {1}, 3);

  EXPECT_EQ(cache.cells[0].seq_id, (std::set<nmt_seq_id>{0}));
  EXPECT_EQ(cache.cells[0].pos, 0);
  EXPECT_EQ(cache.cells[2].seq_id, (std::set<nmt_seq_id>{0}));
  EXPECT_EQ(cache.cells[1].pos, -1);
  EXPECT_EQ(cache.cells[3].pos, -1);

  // No beam left: every cell is free.
  nmtKvCacheReassignSeqs(cache, {}, 3);
  for (const auto& cell : cache.cells) {
    EXPECT_EQ(cell.pos, -1);
    EXPECT_TRUE(cell.seq_id.empty());
  }
}

TEST(NmtBeamKvCache, MaskKeepsEachBeamToItsOwnHistory) {
  nmt_kv_cache cache = makeBeamCache();
  // A cell of beam 0 at a later position than the tokens below.
  cache.cells[4].pos = 3;
  cache.cells[4].seq_id = {0};

  const int nTokens = 3;
  const int nKv = 5;
  nmt_batch batch = nmtBatchInit(nTokens, 1);
  batch.n_tokens = nTokens;
  for (int i = 0; i < nTokens; ++i) {
    batch.pos[i] = 2;
    batch.n_seq_id[i] = 1;
    batch.seq_id[i][0] = i;
  }

  std::vector<float> mask;
  nmtKvCacheBuildMask(cache, batch, nKv, mask);
  nmtBatchFree(batch);

  ASSERT_EQ(mask.size(), static_cast<size_t>(nTokens * nKv));
  const std::vector<std::vector<bool>> visible = {
      {true, true, false, false, false}, // beam 0: BOS, its token
      {true, false, true, false, false}, // beam 1
      {true, false, false, true, false}, // beam 2
  };
  for (int i = 0; i < nTokens; ++i) {
    for (int j = 0; j < nKv; ++j) {
      const float value = mask[static_cast<size_t>(i) * nKv + j];
      if (visible[i][j]) {
        EXPECT_EQ(value, 0.0F) << "token " << i << " cell " << j;
      } else {
        EXPECT_TRUE(std::isinf(value) && value < 0)
            << "token " << i << " cell " << j;
      }
    }
  }
}
