// NOLINTBEGIN
#include "nmt_graph_encoder.hpp"

#include <cmath>
#include <vector>

#include "nmt.hpp"
#include "nmt_utils.hpp"
#include "qvac-lib-inference-addon-cpp/Logger.hpp"

struct ggml_cgraph*
nmt_build_graph_encoder(nmt_context& ctx, nmt_state& state) {
  const auto& model = ctx.model;
  const auto& hparams = model.hparams;

  const int n_ctx = state.exp_n_encoder_ctx > 0 ? state.exp_n_encoder_ctx
                                                : hparams.n_encoder_ctx;
  const int n_state = hparams.d_model;
  const int n_head = hparams.n_encoder_heads;
  const int n_layer = hparams.n_encoder_layers;

  const float embed_scaling = std::sqrt(hparams.d_model);
  const int n_state_head = n_state / n_head;

  const int n_ctx_pad = GGML_PAD(n_ctx, 256);

  struct ggml_init_params params = {
      /*.mem_size   =*/state.sched_encode.meta.size(),
      /*.mem_buffer =*/state.sched_encode.meta.data(),
      /*.no_alloc   =*/true,
  };

  struct ggml_context* ctx0 = ggml_init(params);

  ggml_cgraph* gf = ggml_new_graph_custom(ctx0, NMT_MAX_NODES, false);
  struct ggml_tensor* cur = nullptr;

  if (state.text_tokens.size() == 0) {
    state.text_tokens.resize(7);
  }
  struct ggml_tensor* indices =
      ggml_new_tensor_1d(ctx0, GGML_TYPE_I32, state.tokens_to_process);
  ggml_set_name(indices, "token_ids");
  ggml_set_input(indices);

  cur = ggml_get_rows(ctx0, ctx.model.m_encoder_embeddings, indices);
  if (hparams.scale_embedding) {
    cur = ggml_scale(ctx0, cur, embed_scaling);
  }

  if (hparams.layernorm_embedding) {
    cur = ggml_norm(ctx0, cur, hparams.eps);
    cur = ggml_add(
        ctx0,
        ggml_mul(ctx0, cur, model.m_enc_layer_norm_w),
        model.m_enc_layer_norm_b);
  }

  const float KQscale = 1.0F / sqrtf(float(n_state_head));

  if (model.m_encoder_pos_emb) {
    // IndicTrans2 positions start at padding_idx + 1 = 2, not 0!
    const int padding_idx = 1;
    const int first_token_pos = padding_idx + 1;
    const size_t e_pe_stride = model.m_encoder_pos_emb->ne[0] *
                               ggml_element_size(model.m_encoder_pos_emb);
    const size_t e_pe_offset = first_token_pos * e_pe_stride;

    struct ggml_tensor* encoder_pos_emb = ggml_view_2d(
        ctx0,
        model.m_encoder_pos_emb,
        model.m_encoder_pos_emb->ne[0],
        state.tokens_to_process,
        e_pe_stride,
        e_pe_offset);
    ggml_tensor* temp = ggml_cont(ctx0, encoder_pos_emb);
    cur = ggml_add(ctx0, cur, temp);
  }

  struct ggml_tensor* inpL = cur;

  for (int il = 0; il < n_layer; ++il) {
    const auto& layer = model.layers_encoder[il];

    struct ggml_tensor* attn_residual = inpL;
    if (hparams.encoder_normalize_before) {
      cur = ggml_norm(ctx0, inpL, hparams.eps);
      cur = ggml_add(
          ctx0, ggml_mul(ctx0, cur, layer.attn_ln_0_w), layer.attn_ln_0_b);
    } else {
      cur = inpL;
    }

    // self-attention
    {
      struct ggml_tensor* Qcur = ggml_mul_mat(ctx0, layer.attn_q_w, cur);
      Qcur = ggml_add(ctx0, Qcur, layer.attn_q_b);

      Qcur = ggml_scale(ctx0, Qcur, KQscale);

      struct ggml_tensor* Kcur = ggml_mul_mat(ctx0, layer.attn_k_w, cur);
      Kcur = ggml_add(ctx0, Kcur, layer.attn_k_b);

      struct ggml_tensor* Vcur = ggml_mul_mat(ctx0, layer.attn_v_w, cur);

      Vcur = ggml_add(ctx0, Vcur, layer.attn_v_b);

      // ------
      struct ggml_tensor* Q = nullptr;
      Q = ggml_permute(
          ctx0,
          ggml_reshape_3d(
              ctx0, Qcur, n_state_head, n_head, state.tokens_to_process),
          0,
          2,
          1,
          3);
      {
        struct ggml_tensor* K = nullptr;
        K = ggml_permute(
            ctx0,
            ggml_cast(
                ctx0,
                ggml_reshape_3d(
                    ctx0, Kcur, n_state_head, n_head, state.tokens_to_process),
                ctx.itype),
            0,
            2,
            1,
            3);
        // K * Q
        struct ggml_tensor* KQ = ggml_mul_mat(ctx0, K, Q);

        struct ggml_tensor* KQ_soft_max =
            ggml_soft_max_ext(ctx0, KQ, nullptr, 1.0F, 0.0F);

        struct ggml_tensor* V = nullptr;
        V = ggml_cast(
            ctx0,
            ggml_permute(
                ctx0,
                ggml_reshape_3d(
                    ctx0, Vcur, n_state_head, n_head, state.tokens_to_process),
                1,
                2,
                0,
                3),
            ctx.itype);

        struct ggml_tensor* KQV = ggml_mul_mat(ctx0, V, KQ_soft_max);

        struct ggml_tensor* KQV_merged = ggml_permute(ctx0, KQV, 0, 2, 1, 3);

        cur = ggml_cont_2d(ctx0, KQV_merged, n_state, state.tokens_to_process);
      }
    }

    // projection
    {
      cur = ggml_mul_mat(ctx0, layer.attn_ln_1_w, cur);
      cur = ggml_add(ctx0, cur, layer.attn_ln_1_b);
    }

    cur = ggml_add(ctx0, cur, attn_residual);

    if (!hparams.encoder_normalize_before) {
      cur = ggml_norm(ctx0, cur, hparams.eps);
      cur = ggml_add(
          ctx0, ggml_mul(ctx0, cur, layer.attn_ln_0_w), layer.attn_ln_0_b);
    }

    struct ggml_tensor* inpFF = cur;
    // feed-forward network
    {
      struct ggml_tensor* ffn_residual = inpFF;

      if (hparams.encoder_normalize_before) {
        cur = ggml_norm(ctx0, inpFF, hparams.eps);
        cur =
            ggml_add(ctx0, ggml_mul(ctx0, cur, layer.mlp_ln_w), layer.mlp_ln_b);
      } else {
        cur = inpFF;
      }

      cur = ggml_mul_mat(ctx0, layer.mlp_0_w, cur);
      cur = ggml_add(ctx0, cur, layer.mlp_0_b);
      cur = ggml_gelu(ctx0, cur);
      cur = ggml_mul_mat(ctx0, layer.mlp_1_w, cur);
      cur = ggml_add(ctx0, cur, layer.mlp_1_b);
      cur = ggml_add(ctx0, cur, ffn_residual);

      if (!hparams.encoder_normalize_before) {
        cur = ggml_norm(ctx0, cur, hparams.eps);
        cur =
            ggml_add(ctx0, ggml_mul(ctx0, cur, layer.mlp_ln_w), layer.mlp_ln_b);
      }
    }
    inpL = cur;
  }

  cur = inpL;

  if (hparams.encoder_normalize_before) {
    cur = ggml_norm(ctx0, cur, hparams.eps);
    cur = ggml_add(
        ctx0,
        ggml_mul(ctx0, cur, model.m_encoder_norm_w),
        model.m_encoder_norm_b);
  }

  ggml_build_forward_expand(gf, cur);
  state.embd_enc = cur;

  ggml_free(ctx0);

  return gf;
}

// pre-compute cross-attention memory
struct ggml_cgraph* nmt_build_graph_cross(nmt_context& ctx, nmt_state& state) {
  const auto& model = ctx.model;
  const auto& hparams = model.hparams;

  // const int n_ctx   = state.exp_n_encoder_ctx > 0 ? state.exp_n_encoder_ctx :
  // hparams.n_encoder_ctx;
  const int n_ctx = state.tokens_to_process;
  const int n_state = hparams.d_model;
  const int n_head = hparams.n_encoder_heads;

  const int n_state_head = n_state / n_head;

  const int n_ctx_pad = GGML_PAD(n_ctx, 256);

  struct ggml_init_params params = {
      /*.mem_size   =*/state.sched_cross.meta.size(),
      /*.mem_buffer =*/state.sched_cross.meta.data(),
      /*.no_alloc   =*/true,
  };

  struct ggml_context* ctx0 = ggml_init(params);

  ggml_cgraph* gf = ggml_new_graph(ctx0);
  ggml_tensor* encoder_output =
      ggml_new_tensor_3d(ctx0, GGML_TYPE_F32, n_state, n_ctx, 1);
  ggml_set_name(encoder_output, "encoder_output");
  ggml_set_input(encoder_output);

  // struct ggml_tensor * cur = ggml_view_tensor(ctx0, state.embd_enc);
  struct ggml_tensor* cur = encoder_output;

  const float Kscale = pow(float(n_state_head), -0.25);

  for (int il = 0; il < model.hparams.n_decoder_layers; ++il) {
    auto& layer = model.layers_decoder[il];

    struct ggml_tensor* Kcross = ggml_mul_mat(ctx0, layer.cross_attn_k_w, cur);

    Kcross = ggml_add(ctx0, Kcross, layer.cross_attn_k_b);

    struct ggml_tensor* Vcross = ggml_mul_mat(ctx0, layer.cross_attn_v_w, cur);

    Vcross = ggml_add(ctx0, Vcross, layer.cross_attn_v_b);

    struct ggml_tensor* k;
    struct ggml_tensor* v;

    if (ctx.params.flash_attn) {
      k = ggml_view_1d(
          ctx0,
          state.kv_cross.k,
          n_state * n_ctx,
          (ggml_element_size(state.kv_cross.k) * n_state) * (il * n_ctx_pad));

      v = ggml_view_1d(
          ctx0,
          state.kv_cross.v,
          n_state * n_ctx,
          (ggml_element_size(state.kv_cross.v) * n_state) * (il * n_ctx_pad));
    } else {
      // Vcross = ggml_transpose(ctx0, ggml_reshape_2d(ctx0, Vcross, n_state,
      // n_ctx));

      k = ggml_view_1d(
          ctx0,
          state.kv_cross.k,
          n_state * n_ctx,
          (ggml_element_size(state.kv_cross.k) * n_state) * (il * n_ctx));

      // v = ggml_view_2d(ctx0, state.kv_cross.v, n_ctx, n_state,
      //        (   n_ctx)*ggml_element_size(state.kv_cross.v),
      //        (il*n_ctx)*ggml_element_size(state.kv_cross.v)*n_state);
      v = ggml_view_1d(
          ctx0,
          state.kv_cross.v,
          n_state * n_ctx,
          (ggml_element_size(state.kv_cross.v) * n_state) * (il * n_ctx));
    }
    ggml_build_forward_expand(gf, ggml_cpy(ctx0, Kcross, k));
    ggml_build_forward_expand(gf, ggml_cpy(ctx0, Vcross, v));
  }

  // ggml_graph_print(gf);

  ggml_free(ctx0);

  return gf;
}

bool nmt_encode_internal(nmt_context& ctx, nmt_state& state) {
  // Done for debug purposes to have a match with python input frame.
  auto& sched = state.sched_encode.sched;
  ggml_cgraph* gf = nmt_build_graph_encoder(ctx, state);
  if (!ggml_backend_sched_alloc_graph(sched, gf)) {
    // should never happen as we pre-allocate the memory
    return false;
  }

  // set the input
  {
    ggml_tensor* indices = ggml_graph_get_tensor(gf, "token_ids");
    if (indices != nullptr) {
      ggml_backend_tensor_set(
          indices,
          state.text_tokens.data() + state.text_tokens_begin,
          0,
          ggml_nbytes(indices));
    }
  }

  // Use optimal thread count based on available CPU cores
  if (!ggml_graph_compute_helper(sched, gf, get_optimal_thread_count())) {
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
        "Failed to compute the encoder graph");
    return false;
  }

  state.encoder_result.resize(ggml_nelements(state.embd_enc));
  ggml_backend_tensor_get(
      state.embd_enc,
      state.encoder_result.data(),
      0,
      sizeof(float) * state.encoder_result.size());

  // cross
  {
    auto& sched = state.sched_cross.sched;

    ggml_cgraph* gf = nmt_build_graph_cross(ctx, state);

    if (!ggml_backend_sched_alloc_graph(sched, gf)) {
      // should never happen as we pre-allocate the memory
      return false;
    }

    // setting input
    {
      ggml_tensor* embeddings = ggml_graph_get_tensor(gf, "encoder_output");
      ggml_backend_tensor_set(
          embeddings,
          state.encoder_result.data(),
          0,
          state.encoder_result.size() * sizeof(float));
    }
    // Use optimal thread count based on available CPU cores
    if (!ggml_graph_compute_helper(sched, gf, get_optimal_thread_count())) {
      return false;
    }
  }

  return true;
}

// NOLINTEND
