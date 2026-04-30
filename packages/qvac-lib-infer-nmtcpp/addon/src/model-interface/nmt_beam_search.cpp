// NOLINTBEGIN
#include "nmt_beam_search.hpp"

#include <algorithm>
#include <cmath>
#include <functional>
#include <limits>
#include <queue>
#include <tuple>
#include <vector>

#include "nmt.hpp"
#include "nmt_graph_decoder.hpp"
#include "nmt_state_backend.hpp"
#include "qvac-lib-inference-addon-cpp/Logger.hpp"

struct beam_candidate {
  std::vector<nmt_vocab::id> tokens;
  float score;            // normalized score (for comparison only)
  float cumulative_score; // sum of log probabilities (unnormalized)
  bool finished;
  int kv_cache_idx;

  beam_candidate();
  beam_candidate(const std::vector<nmt_vocab::id>& tokens_, float score_);
};

struct beam_kv_pool {
  std::vector<nmt_kv_cache> kv_caches;
  std::vector<bool> in_use;

  bool init(nmt_context& ctx, int pool_size);
  int acquire();
  void release(int idx);
  void cleanup();
};

beam_candidate::beam_candidate()
    : score(std::numeric_limits<float>::lowest()),
      cumulative_score(std::numeric_limits<float>::lowest()), finished(false),
      kv_cache_idx(-1) {}

beam_candidate::beam_candidate(
    const std::vector<nmt_vocab::id>& tokens_, float score_)
    : tokens(tokens_), score(score_), cumulative_score(score_), finished(false),
      kv_cache_idx(-1) {}

bool beam_kv_pool::init(nmt_context& ctx, int pool_size) {
  kv_caches.resize(pool_size);
  in_use.resize(pool_size, false);

  for (int i = 0; i < pool_size; ++i) {
    if (!nmt_kv_cache_init(
            kv_caches[i],
            ctx.state->backends[0],
            ctx.itype,
            ctx.model.hparams.n_text_state,
            ctx.model.hparams.n_decoder_layers,
            GGML_PAD(ctx.model.hparams.n_decoder_ctx, 256))) {
      return false;
    }
  }
  return true;
}

int beam_kv_pool::acquire() {
  for (int i = 0; i < in_use.size(); ++i) {
    if (!in_use[i]) {
      in_use[i] = true;
      return i;
    }
  }
  return -1;
}

void beam_kv_pool::release(int idx) {
  if (idx >= 0 && idx < in_use.size()) {
    in_use[idx] = false;
  }
}

void beam_kv_pool::cleanup() {
  for (auto& cache : kv_caches) {
    nmt_kv_cache_free(cache);
  }
}

void nmt_set_beam_size(struct nmt_context* ctx, int beam_size) {
  if (!ctx) {
    return;
  }
  ctx->model.config.beam_size = beam_size;
}

int nmt_decode_beam_search(
    struct nmt_context* ctx, int beam_size, int max_tokens) {
  const int vocab_size = ctx->model.hparams.n_tgt_vocab;

  beam_kv_pool kv_pool;
  if (!kv_pool.init(*ctx, beam_size * 2)) {
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
        "Failed to initialize KV cache pool");
    return -1;
  }

  std::vector<beam_candidate> beams;
  beam_candidate initial_beam;
  initial_beam.tokens = {ctx->vocab.bos_token_id};
  initial_beam.score = 0.0f;
  initial_beam.cumulative_score = 0.0f;
  initial_beam.kv_cache_idx = kv_pool.acquire();
  if (initial_beam.kv_cache_idx == -1) {
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
        "Failed to acquire initial KV cache");
    kv_pool.cleanup();
    return -1;
  }
  beams.push_back(initial_beam);

  // Keep 2*beam_size candidates at each step, following HuggingFace's beam
  // search
  const size_t num_candidates_to_keep = 2 * beam_size;

  for (int step = 0; step < max_tokens - 1; ++step) {
    // Store: normalized_score (for comparison), cumulative_score, beam_idx,
    // token_id
    std::priority_queue<
        std::tuple<float, float, int, nmt_vocab::id>,
        std::vector<std::tuple<float, float, int, nmt_vocab::id>>,
        std::greater<>>
        top_candidates;
    bool any_active = false;

    for (int beam_idx = 0; beam_idx < beams.size(); ++beam_idx) {
      const auto& beam = beams[beam_idx];
      if (beam.finished) {
        top_candidates.emplace(beam.score, beam.cumulative_score, beam_idx, -1);
        if (top_candidates.size() > num_candidates_to_keep) {
          top_candidates.pop();
        }
        continue;
      }

      any_active = true;

      nmt_kv_cache original_kv = ctx->state->kv_self;
      ctx->state->kv_self = kv_pool.kv_caches[beam.kv_cache_idx];

      ctx->state->decoder_inputs = beam.tokens;

      nmt_batch_prep_legacy(
          ctx->state->batch,
          ctx->state->decoder_inputs.data() +
              ctx->state->decoder_inputs.size() - 1,
          1,
          ctx->state->decoder_inputs.size() - 1,
          0);

      if (!nmt_decode_internal(*ctx, ctx->state->batch, *ctx->state)) {
        ctx->state->kv_self = original_kv;
        continue;
      }

      kv_pool.kv_caches[beam.kv_cache_idx] = ctx->state->kv_self;
      ctx->state->kv_self = original_kv;

      ggml_tensor* logits = ctx->state->logits_tensor;
      std::vector<float> next_token_logits_vec(vocab_size);

      const int number_of_tokens = ggml_nelements(logits) / vocab_size;

      ggml_backend_tensor_get(
          logits,
          next_token_logits_vec.data(),
          sizeof(float) * (number_of_tokens - 1) * vocab_size,
          sizeof(float) * next_token_logits_vec.size());

      // Apply penalties and filters
      if (ctx->model.config.repetition_penalty > 0.0) {
        apply_repetition_penalty(
            next_token_logits_vec,
            beam.tokens,
            ctx->model.config.repetition_penalty);
      }

      if (ctx->model.config.top_k > 0) {
        apply_top_k_filter(
            next_token_logits_vec,
            ctx->state->decoders[0].logits_id,
            ctx->model.config.top_k);
      }

      std::for_each(
          ctx->vocab.bad_word_ids.begin(),
          ctx->vocab.bad_word_ids.end(),
          [&](const int32_t bad_word_index) {
            next_token_logits_vec[bad_word_index] = -INFINITY;
          });

      apply_no_repeat_ngram_filter(
          next_token_logits_vec,
          beam.tokens,
          ctx->model.config.no_repeat_ngram_size);

      std::vector<float> logprobs(vocab_size);
      nmt_compute_logprobs(next_token_logits_vec, vocab_size, logprobs);

      // OPTIMIZATION: Maintain fixed-size min-heap during iteration (avoids
      // large allocations) Using priority_queue with greater<> creates a
      // min-heap (smallest on top)
      std::priority_queue<
          std::pair<float, int>, // (score, token_id)
          std::vector<std::pair<float, int>>,
          std::greater<std::pair<float, int>> // Min-heap: smallest score on top
          >
          beam_top_k;

      const size_t new_size = beam.tokens.size() + 1;
      const float length_norm =
          (ctx->model.config.length_penalty > 0.0f)
              ? powf(
                    static_cast<float>(new_size),
                    static_cast<float>(ctx->model.config.length_penalty))
              : 1.0f;

      // Single pass: maintain only top num_candidates_to_keep tokens
      for (int token_id = 0; token_id < vocab_size; ++token_id) {
        if (logprobs[token_id] > -INFINITY) {
          float cumulative_score = beam.cumulative_score + logprobs[token_id];
          float normalized_score = cumulative_score / length_norm;

          if (beam_top_k.size() < num_candidates_to_keep) {
            beam_top_k.emplace(normalized_score, token_id);
          } else if (normalized_score > beam_top_k.top().first) {
            beam_top_k.pop(); // Remove smallest
            beam_top_k.emplace(normalized_score, token_id);
          }
        }
      }

      // Add top-K to global candidates
      while (!beam_top_k.empty()) {
        float normalized_score = beam_top_k.top().first;
        int token_id = beam_top_k.top().second;
        beam_top_k.pop();

        float cumulative_score = beam.cumulative_score + logprobs[token_id];
        top_candidates.emplace(
            normalized_score, cumulative_score, beam_idx, token_id);
        if (top_candidates.size() > num_candidates_to_keep) {
          top_candidates.pop();
        }
      }
    }

    if (!any_active) {
      break;
    }

    std::vector<std::tuple<float, float, int, nmt_vocab::id>> all_candidates;
    while (!top_candidates.empty()) {
      all_candidates.push_back(top_candidates.top());
      top_candidates.pop();
    }
    std::reverse(all_candidates.begin(), all_candidates.end());

    std::vector<beam_candidate> new_beams;
    int selected = 0;

    for (const auto& candidate : all_candidates) {
      if (selected >= beam_size)
        break;

      float normalized_score = std::get<0>(candidate);
      float cumulative_score = std::get<1>(candidate);
      int beam_idx = std::get<2>(candidate);
      nmt_vocab::id token_id = std::get<3>(candidate);

      if (token_id == -1) {
        new_beams.push_back(beams[beam_idx]);
      } else {
        beam_candidate new_beam;
        new_beam.tokens = beams[beam_idx].tokens;
        new_beam.tokens.push_back(token_id);
        new_beam.score = normalized_score;
        new_beam.cumulative_score = cumulative_score;

        bool is_eos = (token_id == 2);
        new_beam.finished = is_eos;

        if (!is_eos) {
          new_beam.kv_cache_idx = kv_pool.acquire();
          if (new_beam.kv_cache_idx != -1) {
            const auto& src_cache =
                kv_pool.kv_caches[beams[beam_idx].kv_cache_idx];
            auto& dst_cache = kv_pool.kv_caches[new_beam.kv_cache_idx];

            // OPTIMIZATION: Direct backend-to-backend copy (no CPU bounce)
            // This eliminates 4 memory transfers (2 reads + 2 writes through
            // CPU)
            ggml_backend_tensor_copy(src_cache.k, dst_cache.k);
            ggml_backend_tensor_copy(src_cache.v, dst_cache.v);

            dst_cache.head = src_cache.head;
            dst_cache.n = src_cache.n;
            dst_cache.cells = src_cache.cells;
          }
        } else {
          new_beam.kv_cache_idx = -1;
        }

        new_beams.push_back(new_beam);
      }
      selected++;
    }

    for (auto& old_beam : beams) {
      if (old_beam.kv_cache_idx != -1) {
        bool still_used = false;
        for (const auto& new_beam : new_beams) {
          if (new_beam.kv_cache_idx == old_beam.kv_cache_idx) {
            still_used = true;
            break;
          }
        }
        if (!still_used) {
          kv_pool.release(old_beam.kv_cache_idx);
        }
      }
    }

    beams = std::move(new_beams);
  }

  auto best_beam = std::max_element(
      beams.begin(),
      beams.end(),
      [](const beam_candidate& a, const beam_candidate& b) {
        return a.score < b.score;
      });

  if (best_beam != beams.end()) {
    ctx->state->decoder_inputs = best_beam->tokens;
    // Count actual output tokens (excluding BOS) for consistent metrics
    ctx->state->n_decode =
        static_cast<int32_t>(best_beam->tokens.size()) - 1; // -1 for BOS
  }

  kv_pool.cleanup();

  return 0;
}
// NOLINTEND
