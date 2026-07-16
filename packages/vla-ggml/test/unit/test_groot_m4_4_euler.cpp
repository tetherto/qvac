// M4.4 parity: GR00T flow-matching Euler loop (get_action_with_features).
// Composes the verified builders (action encoder, position embedding, DiT,
// action decoder) into a 4-step Euler integration; state_features and
// vl_embeds are fed from the oracle to isolate the loop composition.
//
// The oracle records x_t entering each step as action_encoder_input.call{t},
// so the update after step t is checked against call{t+1} (steps 0,1,2). The
// step-3 result feeds consumer-side unnormalization, not reproduced here.
//
// Tolerances: per-step cos > 0.9995 is the hard structural gate. The per-step
// relative max-abs-diff is logged for diagnostics but NOT asserted: this
// test chains the Euler output back as the next step's input, so ggml's
// threaded float-reduction order (which varies with the CI runner's CPU core /
// thread count) compounds across the 4 steps and makes the max-abs metric swing
// run-to-run on x86 — observed step-2 rel ~0.005 arm64, 0.025-0.053 x86-64
// Linux, 0.039-0.081 Windows across two runs — while cos stays stable
// (>0.9998 everywhere). No fixed rel bound is both tight and non-flaky here, so
// cos carries the gate; end-to-end output rel is still asserted by
// GrootInferParity (rel < 0.05 on the final action sample).

#include <cmath>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include <ggml.h>
#include <gguf.h>
#include <gtest/gtest.h>

#include "model-interface/groot.hpp"
#include "pi05_compute.hpp"
#include "utils/safetensors_lite.hpp"

namespace {

constexpr int N_ACT = 40;
constexpr int ACT_DIM = 132;
constexpr int S_TOK = 280;
constexpr int DIM = 1536;
constexpr int CROSS_DIM = 2048;
constexpr int N_HEADS = 32;
constexpr int HEAD_DIM = 48;
constexpr int FFN_INNER = 6144;
constexpr int N_LAYERS = 32;
constexpr int OUTPUT_DIM = 1024;
constexpr int ATTEND_TEXT_EVERY_N = 2;
constexpr int N_STEPS = 4;

const char* envOrNull(const char* n) {
  const char* v = std::getenv(n);
  return (v != nullptr && v[0] != '\0') ? v : nullptr;
}

float cosineSim(const float* a, const float* b, size_t n) {
  double dot = 0.0, na = 0.0, nb = 0.0;
  for (size_t i = 0; i < n; ++i) {
    dot += double(a[i]) * double(b[i]);
    na += double(a[i]) * double(a[i]);
    nb += double(b[i]) * double(b[i]);
  }
  const double d = std::sqrt(na) * std::sqrt(nb);
  return d > 0.0 ? float(dot / d) : 0.0f;
}

float relMaxDiff(const float* a, const float* b, size_t n) {
  float m = 0.0f, scale = 0.0f;
  for (size_t i = 0; i < n; ++i) {
    m = std::max(m, std::fabs(a[i] - b[i]));
    scale = std::max(scale, std::fabs(b[i]));
  }
  return scale > 0.0f ? m / scale : m;
}

struct ggml_tensor* gt(struct ggml_context* c, const std::string& n) {
  return ggml_get_tensor(c, n.c_str());
}

qvac_lib_infer_vla_ggml::GrootLinearWeights
linW(struct ggml_context* c, const std::string& p) {
  return {gt(c, p + ".weight"), gt(c, p + ".bias")};
}

} // namespace

TEST(GrootM4_4, EulerLoopMatchesPytorch) {
  const char* ggufPath = envOrNull("GROOT_TEST_GGUF");
  const char* actPath = envOrNull("GROOT_TEST_ACTIVATIONS_V4");
  if (ggufPath == nullptr || actPath == nullptr) {
    GTEST_SKIP() << "Set GROOT_TEST_GGUF and GROOT_TEST_ACTIVATIONS_V4 to run "
                    "the M4.4 Euler-loop parity test.";
  }

  qvac_vla_safetensors_lite::Reader act;
  ASSERT_NO_THROW(act.open(actPath));

  struct ggml_context* ctxW = nullptr;
  struct gguf_init_params gp{};
  gp.no_alloc = false;
  gp.ctx = &ctxW;
  struct gguf_context* gguf = gguf_init_from_file(ggufPath, gp);
  ASSERT_NE(gguf, nullptr);
  ASSERT_NE(ctxW, nullptr);

  using namespace qvac_lib_infer_vla_ggml;

  // ── Weights ────────────────────────────────────────────────────────────
  GrootDitWeights dw{};
  dw.proj_out_1_w = gt(ctxW, "dit.proj_out_1.weight");
  dw.proj_out_1_b = gt(ctxW, "dit.proj_out_1.bias");
  dw.proj_out_2_w = gt(ctxW, "dit.proj_out_2.weight");
  dw.proj_out_2_b = gt(ctxW, "dit.proj_out_2.bias");
  dw.blocks.resize(N_LAYERS);
  for (int i = 0; i < N_LAYERS; ++i) {
    const std::string b = "dit.blk." + std::to_string(i);
    auto& bw = dw.blocks[i];
    bw.norm1_linear_w = gt(ctxW, b + ".norm1_linear.weight");
    bw.norm1_linear_b = gt(ctxW, b + ".norm1_linear.bias");
    bw.attn_q_w = gt(ctxW, b + ".attn_q.weight");
    bw.attn_q_b = gt(ctxW, b + ".attn_q.bias");
    bw.attn_k_w = gt(ctxW, b + ".attn_k.weight");
    bw.attn_k_b = gt(ctxW, b + ".attn_k.bias");
    bw.attn_v_w = gt(ctxW, b + ".attn_v.weight");
    bw.attn_v_b = gt(ctxW, b + ".attn_v.bias");
    bw.attn_out_w = gt(ctxW, b + ".attn_out.weight");
    bw.attn_out_b = gt(ctxW, b + ".attn_out.bias");
    bw.ffn_in_w = gt(ctxW, b + ".ffn_in.weight");
    bw.ffn_in_b = gt(ctxW, b + ".ffn_in.bias");
    bw.ffn_out_w = gt(ctxW, b + ".ffn_out.weight");
    bw.ffn_out_b = gt(ctxW, b + ".ffn_out.bias");
  }
  const GrootLinearWeights aeW1 = linW(ctxW, "embodiment.action_encoder.w1");
  const GrootLinearWeights aeW2 = linW(ctxW, "embodiment.action_encoder.w2");
  const GrootLinearWeights aeW3 = linW(ctxW, "embodiment.action_encoder.w3");
  const GrootLinearWeights dec1 =
      linW(ctxW, "embodiment.action_decoder.layer1");
  const GrootLinearWeights dec2 =
      linW(ctxW, "embodiment.action_decoder.layer2");
  struct ggml_tensor* posEmbedW = gt(ctxW, "dit.position_embedding.weight");
  ASSERT_NE(posEmbedW, nullptr);

  // ── Fixed inputs (fed from the oracle) ─────────────────────────────────
  const std::vector<float> stateFeatV =
      act.readF32("state_encoder_output.call0");
  const std::vector<float> vlV = act.readF32("vl_self_attention_output");
  const std::vector<float> imageMask =
      act.readF32("dit_model_input.call0.kwargs.image_mask");
  const std::vector<float> bbMask =
      act.readF32("dit_model_input.call0.kwargs.backbone_attention_mask");

  // Mutable action buffer, initialised to the sampled noise (x_t entering
  // step 0). The oracle recorded it as action_encoder_input.call0.args.0.
  std::vector<float> actions = act.readF32("action_encoder_input.call0.args.0");
  ASSERT_EQ(actions.size(), static_cast<size_t>(N_ACT * ACT_DIM));

  const float dt = 1.0f / static_cast<float>(N_STEPS);

  for (int step = 0; step < N_STEPS; ++step) {
    const size_t mem = 2048u * 1024u * 1024u;
    std::vector<uint8_t> buf(mem);
    struct ggml_init_params ip{mem, buf.data(), false};
    struct ggml_context* c = ggml_init(ip);
    ASSERT_NE(c, nullptr);

    // actions [132,40]
    struct ggml_tensor* actT =
        ggml_new_tensor_2d(c, GGML_TYPE_F32, ACT_DIM, N_ACT);
    std::memcpy(actT->data, actions.data(), actions.size() * sizeof(float));

    // state_features [1536,1]
    struct ggml_tensor* stateFeat =
        ggml_new_tensor_2d(c, GGML_TYPE_F32, DIM, 1);
    std::memcpy(
        stateFeat->data, stateFeatV.data(), stateFeatV.size() * sizeof(float));

    // vl_embeds [2048,280]
    struct ggml_tensor* vl =
        ggml_new_tensor_2d(c, GGML_TYPE_F32, CROSS_DIM, S_TOK);
    std::memcpy(vl->data, vlV.data(), vlV.size() * sizeof(float));

    // temb from the oracle (isolates the loop from the timestep encoder).
    const std::vector<float> tembV =
        act.readF32("timestep_encoder_output.call" + std::to_string(step));
    struct ggml_tensor* temb = ggml_new_tensor_1d(c, GGML_TYPE_F32, DIM);
    std::memcpy(temb->data, tembV.data(), tembV.size() * sizeof(float));

    // tau for the action encoder from this step's integer bucket.
    const float bucket =
        act.readF32(
               "action_encoder_input.call" + std::to_string(step) + ".args.1")
            .at(0);
    std::vector<float> tauBuf(DIM);
    grootComputeActionTauEnc(bucket, DIM, tauBuf.data());
    struct ggml_tensor* tau = ggml_new_tensor_1d(c, GGML_TYPE_F32, DIM);
    std::memcpy(tau->data, tauBuf.data(), tauBuf.size() * sizeof(float));

    // Additive key masks [S, N+1].
    const int tTok = N_ACT + 1;
    struct ggml_tensor* imMask =
        ggml_new_tensor_2d(c, GGML_TYPE_F32, S_TOK, tTok);
    struct ggml_tensor* txMask =
        ggml_new_tensor_2d(c, GGML_TYPE_F32, S_TOK, tTok);
    auto* imp = static_cast<float*>(imMask->data);
    auto* txp = static_cast<float*>(txMask->data);
    for (int q = 0; q < tTok; ++q) {
      for (int s = 0; s < S_TOK; ++s) {
        const bool valid = bbMask[s] > 0.5f;
        const bool isImg = imageMask[s] > 0.5f;
        imp[q * S_TOK + s] = (valid && isImg) ? 0.0f : -INFINITY;
        txp[q * S_TOK + s] = (valid && !isImg) ? 0.0f : -INFINITY;
      }
    }

    // af = action_encoder(actions, tau) + position_embedding[:40]
    struct ggml_tensor* af = grootBuildActionEncoderGraph(
        c, actT, tau, aeW1, aeW2, aeW3, DIM, N_ACT);
    ASSERT_NE(af, nullptr);
    struct ggml_tensor* pos =
        ggml_view_2d(c, posEmbedW, DIM, N_ACT, posEmbedW->nb[1], 0);
    af = ggml_add(c, af, pos);

    // sa = cat(state_features, af) → [1536, 41]
    struct ggml_tensor* sa = ggml_concat(c, stateFeat, af, /*dim=*/1);

    // DiT → action decoder → velocity[:, -40:]
    struct ggml_tensor* out = grootBuildDitGraph(
        c,
        sa,
        temb,
        vl,
        imMask,
        txMask,
        dw,
        N_LAYERS,
        N_HEADS,
        HEAD_DIM,
        DIM,
        CROSS_DIM,
        FFN_INNER,
        OUTPUT_DIM,
        ATTEND_TEXT_EVERY_N,
        1e-5f,
        nullptr);
    ASSERT_NE(out, nullptr);
    struct ggml_tensor* pred = grootBuildCategoryMlpGraph(c, out, dec1, dec2);
    ASSERT_NE(pred, nullptr); // [132, 41]
    // Drop the leading state token → velocity [132, 40] (contiguous sub-block).
    struct ggml_tensor* vel =
        ggml_view_2d(c, pred, ACT_DIM, N_ACT, pred->nb[1], pred->nb[1]);
    vel = ggml_cont(c, vel);

    struct ggml_cgraph* gf = ggml_new_graph_custom(c, 8192, false);
    ggml_build_forward_expand(gf, vel);
    ASSERT_EQ(pi05_test::computeGraphCpu(gf), GGML_STATUS_SUCCESS);

    // Euler update: actions += dt · velocity.
    const float* velp = static_cast<const float*>(vel->data);
    for (size_t i = 0; i < actions.size(); ++i) {
      actions[i] += dt * velp[i];
    }

    // Verify the updated x_t against the next step's recorded input.
    if (step + 1 < N_STEPS) {
      const std::vector<float> exp = act.readF32(
          "action_encoder_input.call" + std::to_string(step + 1) + ".args.0");
      const float cos = cosineSim(actions.data(), exp.data(), exp.size());
      const float rel = relMaxDiff(actions.data(), exp.data(), exp.size());
      std::cerr << "[M4.4] after step " << step << ": cos=" << cos
                << " rel=" << rel << "\n";
      EXPECT_GT(cos, 0.9995f) << "step " << step;
      // rel intentionally not gated here — see the tolerances note at top.
    }

    ggml_free(c);
  }

  gguf_free(gguf);
  ggml_free(ctxW);
}
