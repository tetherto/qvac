// NOLINTBEGIN
#include "nmt_graph_decoder.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <random>
#include <thread>
#include <unordered_set>
#include <vector>

#include "nmt.hpp"
#include "nmt_beam_search.hpp"
#include "nmt_graph_encoder.hpp"
#include "nmt_loader.hpp"
#include "nmt_state_backend.hpp"
#include "nmt_tokenization.hpp"
#include "nmt_utils.hpp"
#include "qvac-lib-inference-addon-cpp/Logger.hpp"

// Helpers moved from nmt.cpp
void nmt_compute_logprobs(
    const std::vector<float>& logits, const int n_logits,
    std::vector<float>& logprobs) {
  // Use double precision for accumulation to match PyTorch's behavior
  const double logit_max =
      static_cast<double>(*std::max_element(logits.begin(), logits.end()));
  double logsumexp = 0.0;
  for (int i = 0; i < n_logits; ++i) {
    if (logits[i] > -INFINITY) {
      logsumexp += exp(static_cast<double>(logits[i]) - logit_max);
    }
  }
  logsumexp = log(logsumexp) + logit_max;

  for (int i = 0; i < n_logits; ++i) {
    if (logits[i] > -INFINITY) {
      logprobs[i] =
          static_cast<float>(static_cast<double>(logits[i]) - logsumexp);
    } else {
      logprobs[i] = -INFINITY;
    }
  }
}

void indictrans_compute_sinusoidal_positional_embeddings_to_buffer(
    float* data, int d_model, int max_len) {
  // IMPORTANT: IndicTrans2 uses an offset - positions don't start at 0, but at
  // 2

  const int half_dim = d_model / 2;

  for (int table_pos = 0; table_pos < max_len; table_pos++) {
    for (int i = 0; i < half_dim; i++) {
      float freq = powf(10000.0F, -((float)i / (half_dim - 1)));
      float angle = table_pos * freq;
      data[table_pos * d_model + i] = sinf(angle);
      data[table_pos * d_model + (i + half_dim)] = cosf(angle);
    }
  }
}

static void nmt_compute_softmax(
    const std::vector<float>& logits, std::vector<float>& softmax) {
  const auto max = *std::max_element(logits.begin(), logits.end());

  double sum = 0.0f;
  for (int i = 0; i < logits.size(); ++i) {
    softmax[i] = exp(logits[i] - max);
    sum += softmax[i];
  }

  std::for_each(
      softmax.begin(), softmax.end(), [sum](float& el) { el /= sum; });
}

/**
 * @brief Apply nucleus (top-p) sampling filter to a probability vector.
 *
 * Sets softmax[i] = 0 for tokens outside the smallest-probability prefix whose
 * cumulative mass reaches top_p, and re-scales the remaining probabilities so
 * they sum to 1 over the retained (nucleus) set.
 *
 * @param[in,out] softmax      Probability vector (post-softmax). On return,
 *                             excluded entries are 0 and included entries are
 *                             renormalized to sum to 1.
 * @param[in,out] sort_buffer  Workspace sized to vocab, used to store pairs
 *                             of {token_id, probability}. The buffer is resized
 *                             and overwritten by this function.
 * @param[in]     top_p        Nucleus threshold in (0, 1]. Higher keeps more
 * mass.
 */
void apply_top_p_filter(
    std::vector<float>& softmax, std::vector<nmt_pair<int, float>> sort_buffer,
    const float top_p) {
  const int vocab_size = softmax.size();
  sort_buffer.resize(vocab_size);
  for (int i = 0; i < vocab_size; ++i) {
    sort_buffer[i] = nmt_pair(i, softmax[i]);
  }

  std::sort(
      sort_buffer.begin(), sort_buffer.end(), [](const auto& a, const auto& b) {
        return a.second > b.second;
      });

  int cutoff = 0;
  for (double cumulative = 0.0; cutoff < (int)sort_buffer.size(); ++cutoff) {
    cumulative += sort_buffer[cutoff].second;
    if (cumulative >= top_p)
      break;
  }
  // cutoff is inclusive index; keep [0..cutoff]

  std::vector<bool> keep(vocab_size, false);
  for (int i = 0; i <= cutoff && i < (int)sort_buffer.size(); ++i) {
    keep[sort_buffer[i].first] = true;
  }

  double kept_sum = 0.0;
  for (int i = 0; i < vocab_size; ++i) {
    if (!keep[i]) {
      softmax[i] = 0.0f;
    } else {
      kept_sum += softmax[i];
    }
  }

  const float inv_sum = static_cast<float>(1.0 / kept_sum);
  for (int i = 0; i < vocab_size; ++i) {
    if (keep[i])
      softmax[i] *= inv_sum;
  }
}

/**
 * @brief Apply presence-style repetition penalty to selected token logits.
 *
 * Scales the logits corresponding to tokens that have already been generated
 * in the current sequence. Negative logits are multiplied by the penalty,
 * while positive logits are divided by the penalty, reducing the chance of
 * repeating the same tokens. Operates in-place on the provided logits vector.
 *
 * @param[in,out] logits            Logits for the next-token distribution;
 * entries for previously generated token ids are adjusted in place.
 * @param[in]     generated_tokens  Sequence of token ids already generated (may
 * contain duplicates).
 * @param[in]     penalty           Repetition penalty factor (> 1.0 to
 * penalize; 1.0 is no-op).
 */
void apply_repetition_penalty(
    std::vector<float>& logits, const std::vector<int32_t>& generated_tokens,
    const float penalty) {
  std::unordered_set<int32_t> unique_logits(
      generated_tokens.begin(), generated_tokens.end());
  std::for_each(
      unique_logits.begin(),
      unique_logits.end(),
      [&logits, penalty](const int el) {
        if (std::isfinite(logits[el])) {
          if (logits[el] < 0.0f) {
            logits[el] *= penalty;
          } else {
            logits[el] /= penalty;
          }
        }
      });
}

/**
 * @brief Keep only the top-k logits and zero-out the rest for sampling.
 *
 * Builds a parallel array of (logit, token_id) pairs, selects the top-k by
 * logit using nth_element, and writes back a pruned logits vector where only
 * the selected k positions retain their original logit values and all others
 * are set to -INFINITY.
 *
 * @param[in,out] logits    Vector of logits to be pruned in-place. Non-top-k
 * entries will be set to -INFINITY; top-k entries keep their values.
 * @param[in,out] logits_id Workspace of size logits.size() holding pairs
 * {logit, id}. It is filled in this function and used to map back ids.
 * @param[in]     top_k     Number of highest logits to retain.
 */
void apply_top_k_filter(
    std::vector<float>& logits,
    std::vector<nmt_pair<float, nmt_vocab::id>>& logits_id, const int top_k) {
  assert(logits_id.size() == logits.size());
  for (size_t i = 0; i < logits.size(); ++i) {
    logits_id[i].first = logits[i];
    logits_id[i].second = i;
  }

  std::nth_element(
      logits_id.begin(),
      logits_id.begin() + top_k,
      logits_id.end(),
      [](auto& a, auto& b) { return a.first > b.first; });

  std::fill(logits.begin(), logits.end(), -INFINITY);
  for (size_t i = 0; i < top_k; ++i) {
    logits[logits_id[i].second] = logits_id[i].first;
  }
}

/**
 * @brief Prevents generation of immediate repeated n-grams by masking logits.
 *
 * For the most recent (n-1)-token suffix in \p tokens, this function scans the
 * history for a matching (n-1)-gram and, for each match, masks the token that
 * would complete the same n-gram again by setting its logit to -INFINITY.
 * Operates in-place on \p logits and is a no-op for non-positive n or short
 * histories.
 *
 * @param[in,out] logits                Next-token logits to be masked in place
 * when a repeat would occur.
 * @param[in]     tokens                Sequence of already generated token ids
 * (history).
 * @param[in]     no_repeat_ngram_size  Size of the n-gram to forbid (n). If n
 * <= 0, nothing is applied.
 */
void apply_no_repeat_ngram_filter(
    std::vector<float>& logits, const std::vector<nmt_vocab::id>& tokens,
    int no_repeat_ngram_size) {
  if (no_repeat_ngram_size <= 0 || tokens.size() < no_repeat_ngram_size) {
    return;
  }

  const int tokens_size = tokens.size();
  const int ngram_start = tokens_size - no_repeat_ngram_size + 1;

  for (int i = 0; i <= tokens_size - no_repeat_ngram_size; ++i) {
    bool match = true;
    for (int j = 0; j < no_repeat_ngram_size - 1; ++j) {
      if (tokens[i + j] != tokens[ngram_start + j]) {
        match = false;
        break;
      }
    }

    if (match) {
      const nmt_vocab::id blocked_token = tokens[i + no_repeat_ngram_size - 1];
      if (blocked_token >= 0 && blocked_token < logits.size()) {
        logits[blocked_token] = -INFINITY;
      }
    }
  }
}

struct ggml_cgraph* nmt_build_graph_decoder(
    nmt_context& ctx, nmt_state& state, const nmt_batch& batch,
    bool worst_case) {
  const auto& model = ctx.model;
  const auto& hparams = model.hparams;

  auto& kv_self = state.kv_self;

  const int n_ctx = kv_self.size;
  const int d_model = hparams.n_text_state;
  const int n_head = hparams.n_decoder_heads;
  const int n_layer = hparams.n_decoder_layers;

  const int n_state_head = d_model / n_head;

  const float embed_scaling = std::sqrt(hparams.d_model);
  const int seq = batch.n_tokens;
  // const int n_encoder_ctx = state.exp_n_encoder_ctx > 0 ?
  // state.exp_n_encoder_ctx : hparams.n_encoder_ctx;
  const int n_encoder_ctx = state.tokens_to_process;

  const int n_encoder_ctx_pad = GGML_PAD(n_encoder_ctx, 256);

  const int32_t n_kv = worst_case ? n_ctx : kv_self.n;
  const int32_t kv_head = worst_case ? n_ctx - seq : kv_self.head;

  struct ggml_init_params params = {
      /*.mem_size   =*/state.sched_decode.meta.size(),
      /*.mem_buffer =*/state.sched_decode.meta.data(),
      /*.no_alloc   =*/true,
  };

  struct ggml_context* ctx0 = ggml_init(params);

  ggml_cgraph* gf = ggml_new_graph_custom(ctx0, NMT_MAX_NODES, false);

  // const float KQscale = pow(float(n_state_head), -0.25);
  const float KQscale = 1.0F / sqrtf(float(n_state_head));

  struct ggml_tensor* embd = nullptr;
  struct ggml_tensor* position = nullptr;
  struct ggml_tensor* KQ_mask = nullptr;
  struct ggml_tensor* input_ids = nullptr;
  struct ggml_tensor* KQ_mask_f16 = nullptr;
  struct ggml_tensor* encoder_output = nullptr;

  input_ids = ggml_new_tensor_1d(ctx0, GGML_TYPE_I32, 1);
  ggml_set_name(input_ids, "input_ids");
  ggml_set_input(input_ids);

  encoder_output =
      ggml_new_tensor_3d(ctx0, GGML_TYPE_F32, d_model, n_encoder_ctx, 1);
  ggml_set_name(encoder_output, "encoder_output");
  ggml_set_input(encoder_output);

  position = ggml_new_tensor_1d(ctx0, GGML_TYPE_I32, 1);
  ggml_set_name(position, "position");
  ggml_set_input(position);

  // token encoding + position encoding
  struct ggml_tensor* cur = nullptr;
  {
    cur = ggml_get_rows(ctx0, model.m_decoder_embeddings, input_ids);

    cur = ggml_scale(ctx0, cur, embed_scaling);
    ggml_set_name(cur, "decoder_scaled_embeds");

    struct ggml_tensor* pos_emb =
        ggml_new_tensor_2d(ctx0, GGML_TYPE_F32, d_model, 1);
    ggml_set_name(pos_emb, "decoder_pos_emb");
    ggml_set_input(pos_emb);

    cur = ggml_add(ctx0, cur, pos_emb);
    ggml_set_name(cur, "decoder_combined_embeds");

    if (model.m_dec_layer_norm_w != nullptr) {
      cur = ggml_norm(ctx0, cur, hparams.eps);
      cur = ggml_add(
          ctx0,
          ggml_mul(ctx0, cur, model.m_dec_layer_norm_w),
          model.m_dec_layer_norm_b);
    }
  }

  struct ggml_tensor* inpL = cur;
  struct ggml_tensor* aheads_cross_QKs = nullptr;

  for (int il = 0; il < n_layer; ++il) {
    const auto& layer = model.layers_decoder[il];

    struct ggml_tensor* residual = inpL;

    // norm
    cur = ggml_norm(ctx0, inpL, hparams.eps);
    cur = ggml_add(
        ctx0, ggml_mul(ctx0, cur, layer.attn_ln_0_w), layer.attn_ln_0_b);
    ggml_set_name(cur, "self_attn_norm");

    // self-attention
    {
      struct ggml_tensor* Qcur = ggml_mul_mat(ctx0, layer.attn_q_w, cur);

      Qcur = ggml_add(ctx0, Qcur, layer.attn_q_b);

      Qcur = ggml_scale(ctx0, Qcur, KQscale);

      struct ggml_tensor* Kcur = ggml_mul_mat(ctx0, layer.attn_k_w, cur);

      Kcur = ggml_add(ctx0, Kcur, layer.attn_k_b);

      // store key and value to memory

      struct ggml_tensor* Vcur = ggml_mul_mat(ctx0, layer.attn_v_w, cur);
      Vcur = ggml_add(ctx0, Vcur, layer.attn_v_b);

      struct ggml_tensor* k;
      struct ggml_tensor* v;

      if (ctx.params.flash_attn) {
        k = ggml_view_1d(
            ctx0,
            kv_self.k,
            seq * d_model,
            (ggml_element_size(kv_self.k) * d_model) * (il * n_ctx + kv_head));
        v = ggml_view_1d(
            ctx0,
            kv_self.v,
            seq * d_model,
            (ggml_element_size(kv_self.v) * d_model) * (il * n_ctx + kv_head));
      } else {

        k = ggml_view_1d(
            ctx0,
            kv_self.k,
            1 * d_model,
            (ggml_element_size(kv_self.k) * d_model) * (il * n_ctx + kv_head));
        v = ggml_view_1d(
            ctx0,
            kv_self.v,
            1 * d_model,
            (ggml_element_size(kv_self.v) * d_model) * (il * n_ctx + kv_head));

        ggml_build_forward_expand(gf, ggml_cpy(ctx0, Kcur, k));
        ggml_build_forward_expand(gf, ggml_cpy(ctx0, Vcur, v));
      }

      struct ggml_tensor* Q = ggml_permute(
          ctx0,
          ggml_reshape_3d(ctx0, Qcur, n_state_head, n_head, 1),
          0,
          2,
          1,
          3);
      struct ggml_tensor* K = nullptr;
      K = ggml_view_3d(
          ctx0,
          kv_self.k,
          n_state_head,
          n_kv,
          n_head,
          ggml_element_size(kv_self.k) * d_model,
          ggml_element_size(kv_self.k) * n_state_head,
          ggml_element_size(kv_self.k) * d_model * n_ctx * il);

      if (ctx.params.flash_attn) {
        struct ggml_tensor* V = ggml_view_3d(
            ctx0,
            kv_self.v,
            n_state_head,
            n_kv,
            n_head,
            ggml_element_size(kv_self.v) * d_model,
            ggml_element_size(kv_self.v) * n_state_head,
            ggml_element_size(kv_self.v) * d_model * n_ctx * il);

        cur = ggml_flash_attn_ext(ctx0, Q, K, V, KQ_mask_f16, 1.0F, 0.0F, 0.0F);

        cur = ggml_reshape_2d(ctx0, cur, d_model, seq);
      } else {
        // K * Q
        struct ggml_tensor* KQ = ggml_mul_mat(ctx0, K, Q);
        struct ggml_tensor* KQ_soft_max =
            ggml_soft_max_ext(ctx0, KQ, nullptr, 1.0F, 0.0F);

        struct ggml_tensor* V = ggml_view_3d(
            ctx0,
            kv_self.v,
            n_state_head,
            n_kv,
            n_head,
            ggml_element_size(kv_self.v) * d_model,
            ggml_element_size(kv_self.v) * n_state_head,
            ggml_element_size(kv_self.v) * d_model * n_ctx * il);

        V = ggml_permute(ctx0, V, 1, 0, 2, 3);
        V = ggml_cont(ctx0, V);

        struct ggml_tensor* KQV = ggml_mul_mat(ctx0, V, KQ_soft_max);

        struct ggml_tensor* KQV_merged = ggml_permute(ctx0, KQV, 0, 2, 1, 3);

        cur = ggml_cont_2d(ctx0, KQV_merged, d_model, 1);
      }
    }

    // projection
    {
      cur = ggml_mul_mat(ctx0, layer.attn_ln_1_w, cur);
      cur = ggml_add(ctx0, cur, layer.attn_ln_1_b);
    }

    // add the input
    struct ggml_tensor* inpCA = ggml_add(ctx0, cur, residual);

    struct ggml_tensor* cross_residual = inpCA;

    // norm
    {
      cur = ggml_norm(ctx0, inpCA, hparams.eps); // note: we use inpCA here

      cur = ggml_add(
          ctx0,
          ggml_mul(ctx0, cur, layer.cross_attn_ln_0_w),
          layer.cross_attn_ln_0_b);
    }

    residual = cur;

    // cross-attention
    {
      struct ggml_tensor* Qcur = ggml_mul_mat(ctx0, layer.cross_attn_q_w, cur);

      Qcur = ggml_add(ctx0, Qcur, layer.cross_attn_q_b);

      struct ggml_tensor* Q = ggml_permute(
          ctx0, // n_tokens is set to 1
          ggml_reshape_3d(ctx0, Qcur, n_state_head, n_head, 1),
          0,
          2,
          1,
          3);

      if (ctx.params.flash_attn) {
        struct ggml_tensor* Kcross = ggml_view_3d(
            ctx0,
            state.kv_cross.k,
            n_state_head,
            n_encoder_ctx_pad,
            n_head,
            ggml_element_size(state.kv_cross.k) * d_model,
            ggml_element_size(state.kv_cross.k) * n_state_head,
            ggml_element_size(state.kv_cross.k) * d_model * n_encoder_ctx_pad *
                il);

        struct ggml_tensor* Vcross = ggml_view_3d(
            ctx0,
            state.kv_cross.v,
            n_state_head,
            n_encoder_ctx_pad,
            n_head,
            ggml_element_size(state.kv_cross.v) * d_model,
            ggml_element_size(state.kv_cross.v) * n_state_head,
            ggml_element_size(state.kv_cross.v) * d_model * n_encoder_ctx_pad *
                il);

        cur = ggml_flash_attn_ext(
            ctx0, Q, Kcross, Vcross, nullptr, KQscale, 0.0F, 0.0F);

        cur = ggml_reshape_2d(ctx0, cur, d_model, seq);
      } else {
        struct ggml_tensor* Kcross = nullptr;
        struct ggml_tensor* Vcross = nullptr;

        Kcross = ggml_view_3d(
            ctx0,
            state.kv_cross.k,
            n_state_head,
            n_encoder_ctx,
            n_head,
            ggml_element_size(state.kv_cross.k) * d_model,
            ggml_element_size(state.kv_cross.k) * n_state_head,
            ggml_element_size(state.kv_cross.k) * d_model * n_encoder_ctx * il);

        Vcross = ggml_view_3d(
            ctx0,
            state.kv_cross.v,
            n_state_head,
            n_encoder_ctx,
            n_head,
            ggml_element_size(state.kv_cross.v) * d_model,
            ggml_element_size(state.kv_cross.v) * n_state_head,
            ggml_element_size(state.kv_cross.v) * d_model * n_encoder_ctx * il);
        Vcross = ggml_permute(ctx0, Vcross, 1, 0, 2, 3);

        Vcross = ggml_cont(ctx0, Vcross);

        // K * Q
        struct ggml_tensor* KQ = ggml_mul_mat(ctx0, Kcross, Q);
        struct ggml_tensor* KQ_soft_max =
            ggml_soft_max_ext(ctx0, KQ, nullptr, KQscale, 0.0F);
        struct ggml_tensor* KQV = ggml_mul_mat(ctx0, Vcross, KQ_soft_max);
        struct ggml_tensor* KQV_merged = ggml_permute(ctx0, KQV, 0, 2, 1, 3);
        cur = ggml_cont_2d(ctx0, KQV_merged, d_model, 1);
      }
    }
    // projection
    {
      cur = ggml_mul_mat(ctx0, layer.cross_attn_ln_1_w, cur);

      cur = ggml_add(ctx0, cur, layer.cross_attn_ln_1_b);
    }

    // add the input
    cur = ggml_add(ctx0, cur, cross_residual);

    struct ggml_tensor* ffn_residual = cur;

    // feed-forward network
    {
      // norm
      {
        cur = ggml_norm(ctx0, cur, hparams.eps);

        cur =
            ggml_add(ctx0, ggml_mul(ctx0, cur, layer.mlp_ln_w), layer.mlp_ln_b);
      }

      // fully connected
      cur = ggml_mul_mat(ctx0, layer.mlp_0_w, cur);

      cur = ggml_add(ctx0, cur, layer.mlp_0_b);
      cur = ggml_gelu(ctx0, cur);

      // projection
      cur = ggml_mul_mat(ctx0, layer.mlp_1_w, cur);

      cur = ggml_add(ctx0, cur, layer.mlp_1_b);
    }

    cur = ggml_add(ctx0, cur, ffn_residual);
    inpL = cur;
  }

  cur = inpL;
  struct ggml_tensor* logits = nullptr;

  if (model.m_decoder_norm_w != nullptr) {
    cur = ggml_norm(ctx0, cur, hparams.eps);
    cur = ggml_add(
        ctx0,
        ggml_mul(ctx0, cur, model.m_decoder_norm_w),
        model.m_decoder_norm_b);
  }
  if (hparams.has_lm_head && model.m_lm_head_w != nullptr) {
    logits = ggml_mul_mat(ctx0, model.m_lm_head_w, cur);
  } else {
    logits = ggml_mul_mat(ctx0, model.m_decoder_embeddings, cur);
  }

  ggml_build_forward_expand(gf, logits);
  state.logits_tensor = logits;
  ggml_free(ctx0);

  return gf;
}

bool nmt_decode_internal(nmt_context& ctx, nmt_batch& batch, nmt_state& state) {
  const auto n_tokens = batch.n_tokens;

  auto& kv_self = state.kv_self;
  if (!nmt_kv_cache_find_slot(kv_self, batch)) {
    return false;
  }

  const uint32_t pad = nmt_kv_cache_get_padding(ctx);
  kv_self.n = std::min(
      kv_self.size,
      std::max(pad, GGML_PAD(nmt_kv_cache_cell_max(kv_self), pad)));

  auto& sched = state.sched_decode.sched;
  ggml_cgraph* gf = nmt_build_graph_decoder(ctx, state, batch, false);

  if (!ggml_backend_sched_alloc_graph(sched, gf)) {
    // should never happen as we pre-allocate the memory
    return false;
  }

  ggml_tensor* input_ids = ggml_graph_get_tensor(gf, "input_ids");
  if (input_ids != nullptr) {
    // Set bos_token_id from the batch token sequence
    ggml_backend_tensor_set(
        input_ids,
        batch.token + (batch.n_tokens - 1),
        0,
        ggml_element_size(input_ids));
  }
  ggml_tensor* position_tensor = ggml_graph_get_tensor(gf, "position");
  if (position_tensor != nullptr) {
    ggml_backend_tensor_set(
        position_tensor,
        batch.pos + (batch.n_tokens - 1),
        0,
        ggml_element_size(position_tensor));
  }

  ggml_tensor* encoder_output_tensor =
      ggml_graph_get_tensor(gf, "encoder_output");
  if (encoder_output_tensor != nullptr) {
    ggml_backend_tensor_set(
        encoder_output_tensor,
        state.encoder_result.data(),
        0,
        state.encoder_result.size() * sizeof(float));
  }

  ggml_tensor* decoder_pos_emb = ggml_graph_get_tensor(gf, "decoder_pos_emb");
  if (decoder_pos_emb != nullptr) {
    const int d_model = ctx.model.hparams.n_text_state;
    const int logical_pos = batch.pos[batch.n_tokens - 1];
    const int offset = 2;
    const int actual_pos = logical_pos + offset;
    const int table_size = actual_pos + 1;

    std::vector<float> pos_table(d_model * table_size);
    indictrans_compute_sinusoidal_positional_embeddings_to_buffer(
        pos_table.data(), d_model, table_size);

    std::vector<float> pos_embeds(d_model);
    std::copy(
        pos_table.begin() + actual_pos * d_model,
        pos_table.begin() + (actual_pos + 1) * d_model,
        pos_embeds.begin());

    ggml_backend_tensor_set(
        decoder_pos_emb,
        pos_embeds.data(),
        0,
        sizeof(float) * pos_embeds.size());
  }

  // Use optimal thread count based on available CPU cores
  if (!ggml_graph_compute_helper(sched, gf, get_optimal_thread_count())) {
    return false;
  }

  ggml_tensor* logits = ggml_graph_node(gf, -1);

  int vocab_size = ctx.model.hparams.n_tgt_vocab;
  std::vector<float> next_token_logits_vec(vocab_size);

  const int number_of_tokens = ggml_nelements(logits) / vocab_size;

  ggml_backend_tensor_get(
      logits,
      next_token_logits_vec.data(),
      sizeof(float) * (number_of_tokens - 1) * vocab_size,
      sizeof(float) * next_token_logits_vec.size());

  if (ctx.model.config.repetition_penalty > 0.0) {
    apply_repetition_penalty(
        next_token_logits_vec,
        state.decoder_inputs,
        ctx.model.config.repetition_penalty);
  }

  if (ctx.model.config.temperature > 0.0) {
    std::for_each(
        next_token_logits_vec.begin(),
        next_token_logits_vec.end(),
        [&ctx](float& el) { el /= ctx.model.config.temperature; });
  }

  if (ctx.model.config.top_k > 0) {
    apply_top_k_filter(
        next_token_logits_vec,
        state.decoders[0].logits_id,
        ctx.model.config.top_k);
  }

  std::for_each(
      ctx.vocab.bad_word_ids.begin(),
      ctx.vocab.bad_word_ids.end(),
      [&](const int32_t bad_word_index) {
        next_token_logits_vec[bad_word_index] = -INFINITY;
      });

  apply_no_repeat_ngram_filter(
      next_token_logits_vec,
      state.decoder_inputs,
      ctx.model.config.no_repeat_ngram_size);

  int next_token_id = -1;
  // Sampling (only if temperature != 1.0 or top_p != 1.0 or top_k > 0)
  // temperature=1.0 and top_p=1.0 are neutral values that should use greedy
  // decoding
  const bool sampling =
      (ctx.model.config.temperature > 0.0 &&
       ctx.model.config.temperature != 1.0) ||
      ctx.model.config.top_k > 0 ||
      (ctx.model.config.top_p > 0.0 && ctx.model.config.top_p < 1.0);
  if (sampling) {
    ctx.state->decoders[0].probs.resize(next_token_logits_vec.size());
    auto& softmax = ctx.state->decoders[0].probs;

    nmt_compute_softmax(next_token_logits_vec, softmax);

    const float top_p = ctx.model.config.top_p;
    if (top_p > 0.0 && top_p < 1.0) {
      apply_top_p_filter(softmax, ctx.state->decoders[0].sorted_probs, top_p);
    }

    std::discrete_distribution<> dist(softmax.begin(), softmax.end());
    next_token_id = dist(state.decoders[0].rng);
  }
  // Greedy
  else {
    std::vector<float> logprobs(next_token_logits_vec.size());
    nmt_compute_logprobs(
        next_token_logits_vec, next_token_logits_vec.size(), logprobs);

    auto next_token = std::max_element(logprobs.begin(), logprobs.end());
    next_token_id = next_token - logprobs.begin();
  }

  state.decoder_inputs.emplace_back(next_token_id);
  return true;
}

// NOLINTEND
