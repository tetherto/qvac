// NOLINTBEGIN
#include "nmt_beam_search.hpp"

#include <algorithm>
#include <cmath>
#include <functional>
#include <limits>
#include <queue>
#include <thread>
#include <tuple>
#include <vector>

#include "inference-addon-cpp/Logger.hpp"
#include "nmt.hpp"
#include "nmt_graph_decoder.hpp"
#include "nmt_state_backend.hpp"

struct beam_candidate {
  std::vector<nmt_vocab::id> tokens;
  float score;            // normalized score (for comparison only)
  float cumulative_score; // sum of log probabilities (unnormalized)
  bool finished;
  // Sequence id of this beam in the shared self-attention cache, or -1 for a
  // finished beam, which needs no cache.
  int seq_id;

  beam_candidate();
  beam_candidate(const std::vector<nmt_vocab::id>& tokens_, float score_);
};

beam_candidate::beam_candidate()
    : score(std::numeric_limits<float>::lowest()),
      cumulative_score(std::numeric_limits<float>::lowest()), finished(false),
      seq_id(-1) {}

beam_candidate::beam_candidate(
    const std::vector<nmt_vocab::id>& tokens_, float score_)
    : tokens(tokens_), score(score_), cumulative_score(score_), finished(false),
      seq_id(-1) {}

void nmt_set_beam_size(struct nmt_context* ctx, int beam_size) {
  if (!ctx) {
    return;
  }
  ctx->model.config.beam_size = beam_size;
}

int nmtDecodeBeamSearch(
    struct nmt_context* ctx, int beamSize,
    int maxTokens) { // NOLINT(readability-identifier-naming)
  const int vocab_size = ctx->model.hparams.n_tgt_vocab;
  nmt_state& state = *ctx->state;

  // All beams share one self-attention cache, on the backend the decoder runs
  // on. Each cell records which beams' sequences contain it, so a beam that
  // continues another shares its prefix instead of copying it, and every live
  // beam is decoded in a single batch per step. A beam needs at most one
  // decoder context of cells, and live beams never exceed beamSize.
  const int n_ctx_pad = GGML_PAD(ctx->model.hparams.n_decoder_ctx, 256);
  nmt_kv_cache beam_kv;
  if (!nmtKvCacheInit(
          beam_kv,
          state.backends[0],
          ctx->itype,
          ctx->model.hparams.n_text_state,
          ctx->model.hparams.n_decoder_layers,
          beamSize * n_ctx_pad)) {
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
        "Failed to initialize the beam search KV cache");
    return -1;
  }
  nmtKvCacheClear(beam_kv);
  std::swap(state.kv_self, beam_kv);

  std::vector<beam_candidate> beams;
  beam_candidate initial_beam;
  initial_beam.tokens = {ctx->vocab.bos_token_id};
  initial_beam.score = 0.0f;
  initial_beam.cumulative_score = 0.0f;
  initial_beam.seq_id = 0;
  beams.push_back(initial_beam);

  // Keep 2*beam_size candidates at each step, following HuggingFace's beam
  // search
  const size_t num_candidates_to_keep = 2 * beamSize;

  nmt_batch& batch = state.batch;
  std::vector<float> all_logits;
  std::vector<int> batch_row(beamSize * 2, -1);

  for (int step = 0; step < maxTokens - 1; ++step) {
    // One batch row per live beam. Live beams all have the same length.
    batch.n_tokens = 0;
    for (int beam_idx = 0; beam_idx < static_cast<int>(beams.size());
         ++beam_idx) {
      batch_row[beam_idx] = -1;
      const auto& beam = beams[beam_idx];
      if (beam.finished) {
        continue;
      }
      const int row = batch.n_tokens++;
      batch_row[beam_idx] = row;
      batch.token[row] = beam.tokens.back();
      batch.pos[row] = static_cast<nmt_pos>(beam.tokens.size()) - 1;
      batch.n_seq_id[row] = 1;
      batch.seq_id[row][0] = beam.seq_id;
      batch.logits[row] = 1;
    }

    if (batch.n_tokens == 0) {
      break;
    }

    if (!nmtDecodeGraph(*ctx, batch, state)) {
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
          "Beam search decode step failed; keeping the beams so far");
      break;
    }

    all_logits.resize(static_cast<size_t>(batch.n_tokens) * vocab_size);
    ggml_backend_tensor_get(
        state.logits_tensor,
        all_logits.data(),
        0,
        sizeof(float) * all_logits.size());

    // Score each live beam's continuations. Beams are independent, so they
    // are scored in parallel; each keeps its best num_candidates_to_keep in
    // ascending order, and the results are merged below in beam order, as a
    // sequential loop would.
    using candidate_t = std::tuple<float, float, int, nmt_vocab::id>;
    std::vector<std::vector<candidate_t>> beam_candidates(beams.size());

    auto score_beam = [&](int beam_idx) {
      const auto& beam = beams[beam_idx];
      const auto row_begin =
          all_logits.begin() +
          static_cast<std::ptrdiff_t>(batch_row[beam_idx]) * vocab_size;
      std::vector<float> next_token_logits_vec(
          row_begin, row_begin + vocab_size);

      // Apply penalties and filters
      if (ctx->model.config.repetition_penalty > 0.0) {
        applyRepetitionPenalty(
            next_token_logits_vec,
            beam.tokens,
            ctx->model.config.repetition_penalty);
      }

      if (ctx->model.config.top_k > 0) {
        // Per-thread workspace, sized to the target vocabulary this step
        // scores; applyTopKFilter writes one entry per logit.
        std::vector<nmt_pair<float, nmt_vocab::id>> logits_id(
            next_token_logits_vec.size());
        applyTopKFilter(
            next_token_logits_vec, logits_id, ctx->model.config.top_k);
      }

      std::for_each(
          ctx->vocab.bad_word_ids.begin(),
          ctx->vocab.bad_word_ids.end(),
          [&](const int32_t bad_word_index) {
            next_token_logits_vec[bad_word_index] = -INFINITY;
          });

      applyNoRepeatNgramFilter(
          next_token_logits_vec,
          beam.tokens,
          ctx->model.config.no_repeat_ngram_size);

      // log-softmax, as nmtComputeLogprobs computes it, applied per token
      // inside the selection loop instead of into a second full-vocab array.
      const double logit_max = static_cast<double>(*std::max_element(
          next_token_logits_vec.begin(), next_token_logits_vec.end()));
      double logsumexp = 0.0;
      for (int i = 0; i < vocab_size; ++i) {
        if (next_token_logits_vec[i] > -INFINITY) {
          logsumexp +=
              exp(static_cast<double>(next_token_logits_vec[i]) - logit_max);
        }
      }
      logsumexp = log(logsumexp) + logit_max;

      // Maintain a fixed-size min-heap of this beam's best continuations
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

      for (int token_id = 0; token_id < vocab_size; ++token_id) {
        if (next_token_logits_vec[token_id] > -INFINITY) {
          const float logprob = static_cast<float>(
              static_cast<double>(next_token_logits_vec[token_id]) - logsumexp);
          float cumulative_score = beam.cumulative_score + logprob;
          float normalized_score = cumulative_score / length_norm;

          if (beam_top_k.size() < num_candidates_to_keep) {
            beam_top_k.emplace(normalized_score, token_id);
          } else if (normalized_score > beam_top_k.top().first) {
            beam_top_k.pop(); // Remove smallest
            beam_top_k.emplace(normalized_score, token_id);
          }
        }
      }

      auto& out = beam_candidates[beam_idx];
      while (!beam_top_k.empty()) {
        float normalized_score = beam_top_k.top().first;
        int token_id = beam_top_k.top().second;
        beam_top_k.pop();

        const float logprob = static_cast<float>(
            static_cast<double>(next_token_logits_vec[token_id]) - logsumexp);
        float cumulative_score = beam.cumulative_score + logprob;
        out.emplace_back(
            normalized_score, cumulative_score, beam_idx, token_id);
      }
    };

    std::vector<int> live_beams;
    for (int beam_idx = 0; beam_idx < static_cast<int>(beams.size());
         ++beam_idx) {
      if (!beams[beam_idx].finished) {
        live_beams.push_back(beam_idx);
      }
    }
    // At most one thread per core; this thread takes the first share.
    const int n_workers = std::max(
        1,
        std::min(
            static_cast<int>(live_beams.size()),
            static_cast<int>(std::thread::hardware_concurrency())));
    auto score_share = [&](int worker) {
      for (size_t k = worker; k < live_beams.size(); k += n_workers) {
        score_beam(live_beams[k]);
      }
    };
    std::vector<std::thread> workers;
    for (int worker = 1; worker < n_workers; ++worker) {
      workers.emplace_back(score_share, worker);
    }
    score_share(0);
    for (auto& worker : workers) {
      worker.join();
    }

    // Store: normalized_score (for comparison), cumulative_score, beam_idx,
    // token_id
    std::priority_queue<candidate_t, std::vector<candidate_t>, std::greater<>>
        top_candidates;

    for (int beam_idx = 0; beam_idx < static_cast<int>(beams.size());
         ++beam_idx) {
      const auto& beam = beams[beam_idx];
      if (beam.finished) {
        top_candidates.emplace(beam.score, beam.cumulative_score, beam_idx, -1);
        if (top_candidates.size() > num_candidates_to_keep) {
          top_candidates.pop();
        }
        continue;
      }
      for (const auto& candidate : beam_candidates[beam_idx]) {
        top_candidates.push(candidate);
        if (top_candidates.size() > num_candidates_to_keep) {
          top_candidates.pop();
        }
      }
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
      if (selected >= beamSize)
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
        // For now, the parent's sequence; renumbered below.
        new_beam.seq_id = is_eos ? -1 : beams[beam_idx].seq_id;

        new_beams.push_back(new_beam);
      }
      selected++;
    }

    // Give each live beam a sequence id in [0, beamSize) that holds its
    // parent's cells.
    std::vector<nmt_seq_id> parent_seq_ids;
    for (auto& beam : new_beams) {
      if (beam.finished || beam.seq_id < 0) {
        continue;
      }
      parent_seq_ids.push_back(beam.seq_id);
      beam.seq_id = static_cast<int>(parent_seq_ids.size()) - 1;
    }
    nmtKvCacheReassignSeqs(state.kv_self, parent_seq_ids, beamSize);

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

  std::swap(state.kv_self, beam_kv);
  nmtKvCacheFree(beam_kv);

  return 0;
}
// NOLINTEND
