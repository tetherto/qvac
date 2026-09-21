// Multi-embodiment numerical parity — every SHIPPED embodiment row of a multi-
// embodiment GGUF is sliced out and run through the three
// embodiment-conditioned submodules (state_encoder, action_encoder,
// action_decoder — the only per- embodiment weights), then diffed against the
// PyTorch oracle. The oracle fixture is produced by `dump_groot_activations.py
// --mode sweep`: it feeds the same three submodules a FIXED synthetic input per
// cat_id, so no cameras / real observation are needed (the rest of the action
// head is embodiment-agnostic).
//
// This complements test_groot_infer_parity (one embodiment, end-to-end through
// the real pipeline): here we cheaply validate that ALL shipped rows slice +
// matmul correctly, which the single-embodiment e2e test can't reach.
//
// Env gates (both required, else SKIP):
//   GROOT_TEST_SWEEP_GGUF          — a multi-embodiment GGUF (rank-3
//   embodiment.*) GROOT_TEST_SWEEP_ACTIVATIONS   — the --mode sweep safetensors
//   dump
// The GGUF and the dump MUST come from the same checkpoint.

#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

#include <ggml.h>
#include <gguf.h>
#include <gtest/gtest.h>

#include "model-interface/groot.hpp"
#include "pi05_compute.hpp"
#include "utils/safetensors_lite.hpp"

using namespace qvac_lib_infer_vla_ggml;

namespace {

// Action-head dims — match dump_groot_activations.py's sweep constants.
constexpr int STATE_DIM = 132; // max_state_dim
constexpr int ACT_DIM = 132;   // max_action_dim
constexpr int N_ACT = 40;      // action horizon
constexpr int DEC_DIM = 1024;  // dit_output_dim (action_decoder input)
constexpr int HIDDEN = 1536;   // input_embedding_dim
constexpr float SWEEP_T = 0.5f;
// Vision-probe geometry for the switch test's infer() calls (256 patches per
// camera, 1536 floats per patch — the pinned GR00T patch contract).
constexpr int PATCHES_PER_IMG = 256;
constexpr int IN_FLAT = 1536;

const char* envOrNull(const char* n) {
  const char* v = std::getenv(n);
  return (v != nullptr && v[0] != '\0') ? v : nullptr;
}

float cosineSim(const float* a, const float* b, size_t n) {
  double dot = 0.0, na = 0.0, nb = 0.0;
  for (size_t i = 0; i < n; ++i) {
    dot += double(a[i]) * b[i];
    na += double(a[i]) * a[i];
    nb += double(b[i]) * b[i];
  }
  const double d = std::sqrt(na) * std::sqrt(nb);
  return d > 0.0 ? float(dot / d) : 0.0f;
}

float relMaxDiff(const float* a, const float* b, size_t n) {
  float m = 0.0f, s = 0.0f;
  for (size_t i = 0; i < n; ++i) {
    m = std::max(m, std::fabs(a[i] - b[i]));
    s = std::max(s, std::fabs(b[i]));
  }
  return s > 0.0f ? m / s : m;
}

struct ggml_tensor* g(struct ggml_context* c, const char* n) {
  return ggml_get_tensor(c, n);
}

// Copy the `feed` numpy (…, D) row-major buffer as ggml ne=[D, rows].
struct ggml_tensor* feed2d(
    struct ggml_context* c, const std::vector<float>& data, int d, int rows) {
  struct ggml_tensor* t = ggml_new_tensor_2d(c, GGML_TYPE_F32, d, rows);
  std::memcpy(t->data, data.data(), data.size() * sizeof(float));
  return t;
}

// Slice one embodiment row out of a rank-3 weight (ne=[out,in,n_stored]) into a
// fresh 2-D tensor, and its rank-2 bias (ne=[out,n_stored]) into a 1-D tensor —
// the CPU mirror of grootSliceEmbodiment (each row's block is contiguous, row =
// outermost axis). The result is byte-identical to what the load path feeds the
// graph builders, so weightsPreTransposed stays false (as in M4.2).
GrootLinearWeights sliceLin(
    struct ggml_context* c, struct ggml_context* ctxW,
    const std::string& prefix, int row) {
  struct ggml_tensor* w = g(ctxW, (prefix + ".weight").c_str());
  struct ggml_tensor* b = g(ctxW, (prefix + ".bias").c_str());
  EXPECT_NE(w, nullptr) << prefix << ".weight";
  EXPECT_NE(b, nullptr) << prefix << ".bias";
  EXPECT_EQ(ggml_n_dims(w), 3)
      << prefix << " expected rank-3 (multi-embodiment)";
  EXPECT_EQ(ggml_n_dims(b), 2) << prefix << " bias expected rank-2";

  struct ggml_tensor* wd = ggml_new_tensor_2d(c, w->type, w->ne[0], w->ne[1]);
  const size_t wbytes = ggml_nbytes(wd);
  std::memcpy(
      wd->data,
      static_cast<const char*>(w->data) + size_t(row) * wbytes,
      wbytes);

  struct ggml_tensor* bd = ggml_new_tensor_1d(c, b->type, b->ne[0]);
  const size_t bbytes = ggml_nbytes(bd);
  std::memcpy(
      bd->data,
      static_cast<const char*>(b->data) + size_t(row) * bbytes,
      bbytes);
  return {wd, bd};
}

std::vector<int> readI32Arr(struct gguf_context* gg, const char* key) {
  const int64_t idx = gguf_find_key(gg, key);
  if (idx < 0 || gguf_get_kv_type(gg, idx) != GGUF_TYPE_ARRAY ||
      gguf_get_arr_type(gg, idx) != GGUF_TYPE_INT32) {
    return {};
  }
  const size_t n = gguf_get_arr_n(gg, idx);
  const auto* d = static_cast<const int32_t*>(gguf_get_arr_data(gg, idx));
  return std::vector<int>(d, d + n);
}

// Takes the graph output tensor rather than a raw pointer so the element count
// is checked: cosineSim/relMaxDiff iterate exp.size(), which would run off the
// end of the ggml buffer (UB, not a clean failure) on a shape regression.
float checkClose(
    const char* tag, const struct ggml_tensor* got,
    const std::vector<float>& exp) {
  EXPECT_EQ(got->type, GGML_TYPE_F32) << tag;
  EXPECT_EQ(static_cast<size_t>(ggml_nelements(got)), exp.size()) << tag;
  if (got->type != GGML_TYPE_F32 ||
      static_cast<size_t>(ggml_nelements(got)) != exp.size()) {
    return 0.0f;
  }
  const auto* p = static_cast<const float*>(got->data);
  const float cos = cosineSim(p, exp.data(), exp.size());
  const float rel = relMaxDiff(p, exp.data(), exp.size());
  std::cerr << "[sweep] " << tag << ": cos=" << cos << " rel=" << rel << "\n";
  EXPECT_GT(cos, 0.9995f) << tag;
  EXPECT_LT(rel, 0.01f) << tag;
  return cos;
}

} // namespace

TEST(GrootEmbodimentSweep, AllShippedRowsMatchPytorch) {
  const char* ggufPath = envOrNull("GROOT_TEST_SWEEP_GGUF");
  const char* actPath = envOrNull("GROOT_TEST_SWEEP_ACTIVATIONS");
  if (ggufPath == nullptr || actPath == nullptr) {
    GTEST_SKIP() << "Set GROOT_TEST_SWEEP_GGUF (multi-embodiment) and "
                    "GROOT_TEST_SWEEP_ACTIVATIONS (--mode sweep dump) to run "
                    "the multi-embodiment parity sweep.";
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

  const std::vector<int> storedCatIds =
      readI32Arr(gguf, "groot.embodiment.stored_cat_ids");
  ASSERT_FALSE(storedCatIds.empty())
      << "GROOT_TEST_SWEEP_GGUF is not a multi-embodiment GGUF "
         "(no groot.embodiment.stored_cat_ids)";

  // Shared synthetic inputs (identical across cat_ids); one ggml ctx per row is
  // simplest, so keep the raw buffers here and rebuild leaves each iteration.
  const std::vector<float> stateIn = act.readF32("sweep.input.state");
  const std::vector<float> actionsIn = act.readF32("sweep.input.actions");
  const std::vector<float> decoderIn = act.readF32("sweep.input.decoder");
  ASSERT_EQ(stateIn.size(), size_t(STATE_DIM));
  ASSERT_EQ(actionsIn.size(), size_t(N_ACT) * ACT_DIM);
  ASSERT_EQ(decoderIn.size(), size_t(N_ACT + 1) * DEC_DIM);

  std::vector<float> tauBuf(HIDDEN);
  grootComputeActionTauEnc(SWEEP_T, HIDDEN, tauBuf.data());

  // state_encoder output per validated row, kept for the wrong-row negative
  // control after the loop (see there). Parallel to `rowCatIds`.
  std::vector<std::vector<float>> mineSE;
  std::vector<std::vector<float>> oracleSE;
  std::vector<int> rowCatIds;

  int checked = 0;
  for (size_t row = 0; row < storedCatIds.size(); ++row) {
    const int cid = storedCatIds[row];
    const std::string base = "sweep.cat" + std::to_string(cid) + ".";
    if (!act.has(base + "state_encoder_output")) {
      ADD_FAILURE() << "cat" << cid
                    << " is shipped in the GGUF but absent from the sweep "
                       "oracle dump — cannot validate every shipped row";
      continue;
    }

    const size_t mem = 256u * 1024u * 1024u;
    std::vector<uint8_t> buf(mem);
    struct ggml_init_params ip{mem, buf.data(), false};
    struct ggml_context* c = ggml_init(ip);
    ASSERT_NE(c, nullptr);

    float cosSE = 0.0f;
    float cosAE = 0.0f;
    float cosAD = 0.0f;

    // state_encoder (CategorySpecificMLP, ReLU).
    {
      struct ggml_tensor* x = feed2d(c, stateIn, STATE_DIM, 1);
      struct ggml_tensor* out = grootBuildCategoryMlpGraph(
          c,
          x,
          sliceLin(c, ctxW, "embodiment.state_encoder.layer1", row),
          sliceLin(c, ctxW, "embodiment.state_encoder.layer2", row));
      ASSERT_NE(out, nullptr);
      struct ggml_cgraph* gf = ggml_new_graph(c);
      ggml_build_forward_expand(gf, out);
      ASSERT_EQ(pi05_test::computeGraphCpu(gf), GGML_STATUS_SUCCESS);
      const std::vector<float> exp = act.readF32(base + "state_encoder_output");
      cosSE = checkClose(
          ("cat" + std::to_string(cid) + " state_encoder").c_str(), out, exp);
      if (static_cast<size_t>(ggml_nelements(out)) == exp.size()) {
        const auto* p = static_cast<const float*>(out->data);
        mineSE.emplace_back(p, p + exp.size());
        oracleSE.push_back(exp);
        rowCatIds.push_back(cid);
      }
    }

    // action_encoder (MultiEmbodimentActionEncoder, swish).
    {
      struct ggml_tensor* actions = feed2d(c, actionsIn, ACT_DIM, N_ACT);
      struct ggml_tensor* tau = ggml_new_tensor_1d(c, GGML_TYPE_F32, HIDDEN);
      std::memcpy(tau->data, tauBuf.data(), tauBuf.size() * sizeof(float));
      struct ggml_tensor* out = grootBuildActionEncoderGraph(
          c,
          actions,
          tau,
          sliceLin(c, ctxW, "embodiment.action_encoder.w1", row),
          sliceLin(c, ctxW, "embodiment.action_encoder.w2", row),
          sliceLin(c, ctxW, "embodiment.action_encoder.w3", row),
          HIDDEN,
          N_ACT);
      ASSERT_NE(out, nullptr);
      struct ggml_cgraph* gf = ggml_new_graph(c);
      ggml_build_forward_expand(gf, out);
      ASSERT_EQ(pi05_test::computeGraphCpu(gf), GGML_STATUS_SUCCESS);
      cosAE = checkClose(
          ("cat" + std::to_string(cid) + " action_encoder").c_str(),
          out,
          act.readF32(base + "action_encoder_output"));
    }

    // action_decoder (CategorySpecificMLP, ReLU).
    {
      struct ggml_tensor* x = feed2d(c, decoderIn, DEC_DIM, N_ACT + 1);
      struct ggml_tensor* out = grootBuildCategoryMlpGraph(
          c,
          x,
          sliceLin(c, ctxW, "embodiment.action_decoder.layer1", row),
          sliceLin(c, ctxW, "embodiment.action_decoder.layer2", row));
      ASSERT_NE(out, nullptr);
      struct ggml_cgraph* gf = ggml_new_graph(c);
      ggml_build_forward_expand(gf, out);
      ASSERT_EQ(pi05_test::computeGraphCpu(gf), GGML_STATUS_SUCCESS);
      cosAD = checkClose(
          ("cat" + std::to_string(cid) + " action_decoder").c_str(),
          out,
          act.readF32(base + "action_decoder_output"));
    }

    ggml_free(c);
    ++checked;

    // One stable, machine-readable line per shipped embodiment — the CI step
    // that parses these into the job summary greps for this exact marker.
    std::cerr << "[GrootEmbodimentSweep] cat" << cid
              << " state_encoder=" << cosSE << " action_encoder=" << cosAE
              << " action_decoder=" << cosAD << "\n";
  }

  std::cerr << "[sweep] validated " << checked << "/" << storedCatIds.size()
            << " shipped embodiment rows\n";
  // Every shipped row must be present in the oracle and validated — a truncated
  // or mismatched dump must fail, not silently pass on a subset.
  EXPECT_EQ(checked, static_cast<int>(storedCatIds.size()))
      << "not every shipped embodiment row was validated against the oracle";

  // Negative control. Matching each row against its own oracle only proves the
  // cat_id -> stored-row map is right if a WRONG row would have failed, so
  // require that no other embodiment's oracle matches our output better. Rows
  // the checkpoint stores identically tie here and are reported rather than
  // failed, but if EVERY row ties the sweep can't detect a mis-slice at all.
  int separable = 0;
  for (size_t i = 0; i < mineSE.size(); ++i) {
    float bestOther = -1.0f;
    size_t bestJ = 0;
    for (size_t j = 0; j < oracleSE.size(); ++j) {
      if (j == i || oracleSE[j].size() != mineSE[i].size()) {
        continue;
      }
      const float c =
          cosineSim(mineSE[i].data(), oracleSE[j].data(), oracleSE[j].size());
      if (c > bestOther) {
        bestOther = c;
        bestJ = j;
      }
    }
    if (bestOther < 0.0f) {
      continue; // nothing to compare against
    }
    const float self =
        cosineSim(mineSE[i].data(), oracleSE[i].data(), oracleSE[i].size());
    // Rows the checkpoint stores identically (or near-identically) land inside
    // this band, where our q8 noise decides the winner — neither a pass nor a
    // failure signal. A genuine mis-slice lands far outside it: self drops to
    // the cos of two unrelated MLP outputs, nowhere near 1.
    constexpr float kTie = 1e-5f;
    EXPECT_GE(self, bestOther - kTie)
        << "cat" << rowCatIds[i] << " matches cat" << rowCatIds[bestJ]
        << "'s oracle better than its own — the cat_id -> stored-row map is "
           "wrong";
    if (self > bestOther + kTie) {
      ++separable;
    } else {
      std::cerr << "[sweep] cat" << rowCatIds[i]
                << " is indistinguishable from cat" << rowCatIds[bestJ]
                << " (self=" << self << " other=" << bestOther
                << "); those rows store identical weights\n";
    }
  }
  std::cerr << "[sweep] " << separable << "/" << mineSE.size()
            << " rows separable from every other row\n";
  EXPECT_GT(separable, 0)
      << "no embodiment row is distinguishable from the others — this sweep "
         "cannot detect a wrong-row slice";

  gguf_free(gguf);
  ggml_free(ctxW);
}

// Load-time override capstone: pick the first SHIPPED embodiment's tag, load it
// through the real GrootModel ctor override, and confirm the per-embodiment
// num_cameras surfaces on hparams — exercising ctor param ->
// grootResolveEmbodiment
// -> grootSliceEmbodiment -> hparams end to end for a non-baked embodiment.
TEST(GrootEmbodimentSweep, LoadTimeOverrideSurfacesNumCameras) {
  const char* ggufPath = envOrNull("GROOT_TEST_SWEEP_GGUF");
  if (ggufPath == nullptr) {
    GTEST_SKIP() << "Set GROOT_TEST_SWEEP_GGUF to run the override load test.";
  }

  struct gguf_init_params gp{};
  gp.no_alloc = true; // only need the KV table
  struct gguf_context* gguf = gguf_init_from_file(ggufPath, gp);
  ASSERT_NE(gguf, nullptr);

  const std::vector<int> storedCatIds =
      readI32Arr(gguf, "groot.embodiment.stored_cat_ids");
  const std::vector<int> storedCams =
      readI32Arr(gguf, "groot.embodiment.stored_num_cameras");
  const std::vector<int> catIds = readI32Arr(gguf, "groot.embodiment.cat_ids");
  if (storedCatIds.empty()) {
    gguf_free(gguf);
    GTEST_SKIP() << "GROOT_TEST_SWEEP_GGUF is single-embodiment.";
  }

  // Pick a RUNNABLE shipped row (stored num_cameras > 0). Rows with an unknown
  // count (0) are rejected at load — no camera override exists — so they can't
  // exercise this path. Prefer a row whose cat_id differs from the baked
  // default so we exercise a genuinely non-baked override; fall back to the
  // first runnable row otherwise.
  const int64_t bakedIdx = gguf_find_key(gguf, "groot.embodiment_cat_id");
  const int bakedCat =
      bakedIdx >= 0 ? static_cast<int>(gguf_get_val_u32(gguf, bakedIdx)) : -1;
  int wantRow = -1;
  for (size_t r = 0; r < storedCatIds.size(); ++r) {
    if (r < storedCams.size() && storedCams[r] > 0 &&
        storedCatIds[r] != bakedCat) {
      wantRow = static_cast<int>(r);
      break;
    }
  }
  if (wantRow < 0) {
    for (size_t r = 0; r < storedCatIds.size(); ++r) {
      if (r < storedCams.size() && storedCams[r] > 0) {
        wantRow = static_cast<int>(r);
        break;
      }
    }
  }
  if (wantRow < 0) {
    gguf_free(gguf);
    GTEST_SKIP() << "No shipped embodiment has a known num_cameras (>0).";
  }

  // Map the chosen shipped cat_id back to its tag via the full map.
  const int64_t tagsIdx = gguf_find_key(gguf, "groot.embodiment.tags");
  ASSERT_GE(tagsIdx, 0);
  const int wantCat = storedCatIds[wantRow];
  std::string wantTag;
  for (size_t i = 0; i < catIds.size(); ++i) {
    if (catIds[i] == wantCat) {
      wantTag = gguf_get_arr_str(gguf, tagsIdx, i);
      break;
    }
  }
  ASSERT_FALSE(wantTag.empty()) << "no tag maps to shipped cat_id " << wantCat;
  const int expectCams = storedCams[wantRow];
  gguf_free(gguf);

  GrootModel model(
      ggufPath,
      /*forceCpu=*/true,
      /*backendsDir=*/"",
      VlaEmbodimentRequest{wantTag});
  EXPECT_EQ(model.hparams().num_cameras, expectCams);
  EXPECT_EQ(model.hparams().selected_embodiment_cat_id, wantCat);

  // The same row, selected by its numeric id instead of a tag.
  VlaEmbodimentRequest byId;
  byId.cat_id = wantCat;
  GrootModel byIdModel(ggufPath, /*forceCpu=*/true, /*backendsDir=*/"", byId);
  EXPECT_EQ(byIdModel.hparams().selected_embodiment_cat_id, wantCat);
  EXPECT_EQ(byIdModel.hparams().num_cameras, expectCams);
}

// Every stored row is runnable: a row whose num_cameras was unknown at
// conversion time (stored 0 — the count is a data-config property, absent from
// the checkpoint) loads once the caller states the count, both at load and
// through an in-place switch. Without the override those rows are latent
// weights the GGUF can carry but never serve.
TEST(GrootEmbodimentSweep, UnknownCameraRowsRunnableWithExplicitCount) {
  const char* ggufPath = envOrNull("GROOT_TEST_SWEEP_GGUF");
  if (ggufPath == nullptr) {
    GTEST_SKIP()
        << "Set GROOT_TEST_SWEEP_GGUF to run the camera-override test.";
  }

  struct gguf_init_params gp{};
  gp.no_alloc = true; // KV table only
  struct gguf_context* gguf = gguf_init_from_file(ggufPath, gp);
  ASSERT_NE(gguf, nullptr);
  const std::vector<int> storedCatIds =
      readI32Arr(gguf, "groot.embodiment.stored_cat_ids");
  const std::vector<int> storedCams =
      readI32Arr(gguf, "groot.embodiment.stored_num_cameras");
  gguf_free(gguf);
  if (storedCatIds.empty()) {
    GTEST_SKIP() << "GROOT_TEST_SWEEP_GGUF is single-embodiment.";
  }

  // Collect the rows the GGUF cannot serve on its own.
  std::vector<int> unknownCatIds;
  for (size_t r = 0; r < storedCatIds.size(); ++r) {
    if (r >= storedCams.size() || storedCams[r] <= 0) {
      unknownCatIds.push_back(storedCatIds[r]);
    }
  }
  std::cerr << "[cams] " << unknownCatIds.size() << "/" << storedCatIds.size()
            << " stored rows have no stored num_cameras\n";
  if (unknownCatIds.empty()) {
    GTEST_SKIP() << "Every stored row already carries a num_cameras.";
  }

  const int kCams = 2;
  // Without a count, such a row is still rejected — the loader never guesses.
  VlaEmbodimentRequest noCount;
  noCount.cat_id = unknownCatIds.front();
  EXPECT_THROW(
      GrootModel(ggufPath, /*forceCpu=*/true, /*backendsDir=*/"", noCount),
      std::runtime_error);

  VlaEmbodimentRequest withCount;
  withCount.cat_id = unknownCatIds.front();
  withCount.num_cameras = kCams;
  GrootModel model(ggufPath, /*forceCpu=*/true, /*backendsDir=*/"", withCount);
  EXPECT_EQ(model.hparams().selected_embodiment_cat_id, unknownCatIds.front());
  EXPECT_EQ(model.hparams().num_cameras, kCams);

  // Same story for the in-place switch, over every remaining unknown-count row,
  // so "one load serves any included embodiment" holds for the whole ship set.
  for (const int catId : unknownCatIds) {
    VlaEmbodimentRequest req;
    req.cat_id = catId;
    EXPECT_THROW(model.setEmbodiment(req), std::runtime_error)
        << "cat_id " << catId << " must not resolve without a camera count";
    req.num_cameras = kCams;
    ASSERT_NO_THROW(model.setEmbodiment(req)) << "cat_id " << catId;
    EXPECT_EQ(model.hparams().selected_embodiment_cat_id, catId);
    EXPECT_EQ(model.hparams().num_cameras, kCams);
  }
}

// Load-once capstone: one loaded model serves any shipped embodiment. Switching
// in place (GrootModel::setEmbodiment) must be indistinguishable from having
// loaded that embodiment in the first place, so the assertion is a direct
// comparison of the two: a model loaded with the GGUF default and switched to
// row B produces the SAME actions as a model loaded with row B, on identical
// input. Switching back must restore the default's actions exactly.
//
// The oracle fixture supplies a real prompt/state/noise/images probe. It is a
// LIBERO observation, so the actions after a switch are not physically
// meaningful for the other embodiment — that is fine and deliberate: the probe
// only has to be identical across the models being compared, and infer() never
// reads num_cameras (the count is a JS-side validation contract).
// Per-embodiment NUMERICAL correctness is what AllShippedRowsMatchPytorch above
// covers.
TEST(GrootEmbodimentSweep, SwitchEmbodimentMatchesFreshLoadOfThatEmbodiment) {
  const char* ggufPath = envOrNull("GROOT_TEST_SWEEP_GGUF");
  const char* actPath = envOrNull("GROOT_TEST_ACTIVATIONS_V4");
  if (ggufPath == nullptr || actPath == nullptr) {
    GTEST_SKIP() << "Set GROOT_TEST_SWEEP_GGUF (multi-embodiment) and "
                    "GROOT_TEST_ACTIVATIONS_V4 (probe inputs) to run the "
                    "in-place embodiment switch test.";
  }

  // ── Pick a shipped, runnable, non-default embodiment to switch to ──────────
  struct gguf_init_params gp{};
  gp.no_alloc = true; // KV table only
  struct gguf_context* gguf = gguf_init_from_file(ggufPath, gp);
  ASSERT_NE(gguf, nullptr);
  const std::vector<int> storedCatIds =
      readI32Arr(gguf, "groot.embodiment.stored_cat_ids");
  const std::vector<int> storedCams =
      readI32Arr(gguf, "groot.embodiment.stored_num_cameras");
  const std::vector<int> catIds = readI32Arr(gguf, "groot.embodiment.cat_ids");
  if (storedCatIds.empty()) {
    gguf_free(gguf);
    GTEST_SKIP() << "GROOT_TEST_SWEEP_GGUF is single-embodiment.";
  }
  const int64_t bakedIdx = gguf_find_key(gguf, "groot.embodiment_cat_id");
  const int bakedCat =
      bakedIdx >= 0 ? static_cast<int>(gguf_get_val_u32(gguf, bakedIdx)) : -1;
  int wantRow = -1;
  for (size_t r = 0; r < storedCatIds.size(); ++r) {
    if (r < storedCams.size() && storedCams[r] > 0 &&
        storedCatIds[r] != bakedCat) {
      wantRow = static_cast<int>(r);
      break;
    }
  }
  if (wantRow < 0) {
    gguf_free(gguf);
    GTEST_SKIP() << "No shipped embodiment other than the default has a known "
                    "num_cameras (>0) — nothing to switch to.";
  }
  const int64_t tagsIdx = gguf_find_key(gguf, "groot.embodiment.tags");
  ASSERT_GE(tagsIdx, 0);
  std::string wantTag;
  for (size_t i = 0; i < catIds.size(); ++i) {
    if (catIds[i] == storedCatIds[wantRow]) {
      wantTag = gguf_get_arr_str(gguf, tagsIdx, i);
      break;
    }
  }
  ASSERT_FALSE(wantTag.empty());
  const int wantCams = storedCams[wantRow];
  gguf_free(gguf);

  // ── Probe input (shared by every inference below) ──────────────────────────
  qvac_vla_safetensors_lite::Reader act;
  ASSERT_NO_THROW(act.open(actPath));
  const std::vector<float> patches = act.readF32("vision_input.call0.args.0");
  ASSERT_EQ(patches.size() % (PATCHES_PER_IMG * IN_FLAT), 0u);
  const int nImages =
      static_cast<int>(patches.size() / (PATCHES_PER_IMG * IN_FLAT));
  std::vector<const float*> images(nImages);
  for (int i = 0; i < nImages; ++i) {
    images[i] =
        patches.data() + static_cast<size_t>(i) * PATCHES_PER_IMG * IN_FLAT;
  }
  const std::vector<float> state =
      act.readF32("state_encoder_input.call0.args.0");
  ASSERT_EQ(state.size(), static_cast<size_t>(STATE_DIM));
  const std::vector<float> noise =
      act.readF32("action_encoder_input.call0.args.0");
  ASSERT_EQ(noise.size(), static_cast<size_t>(N_ACT) * ACT_DIM);
  const std::vector<float> inputIds =
      act.readF32("backbone_input.call0.args.0.input_ids");
  const std::vector<float> attnMask =
      act.readF32("backbone_input.call0.args.0.attention_mask");
  const int nTok = static_cast<int>(inputIds.size());
  ASSERT_GT(nTok, 0);
  ASSERT_EQ(attnMask.size(), inputIds.size());
  std::vector<int32_t> tokens(nTok);
  for (int t = 0; t < nTok; ++t) {
    tokens[t] = static_cast<int32_t>(std::lround(inputIds[t]));
  }
  std::vector<char> langMaskBuf(nTok);
  for (int t = 0; t < nTok; ++t) {
    langMaskBuf[t] = attnMask[t] > 0.5f ? 1 : 0;
  }
  const bool* langMaskPtr = reinterpret_cast<const bool*>(langMaskBuf.data());

  auto runProbe = [&](GrootModel& m) {
    std::vector<float> out(static_cast<size_t>(N_ACT) * ACT_DIM, 0.0f);
    int nActionsOut = 0;
    VlaTimingGeneric timing{};
    const bool ok = m.infer(
        images.data(),
        nImages,
        /*imgWidth=*/256,
        /*imgHeight=*/256,
        state.data(),
        STATE_DIM,
        tokens.data(),
        langMaskPtr,
        nTok,
        noise.data(),
        out.data(),
        &nActionsOut,
        &timing);
    EXPECT_TRUE(ok);
    EXPECT_EQ(nActionsOut, N_ACT);
    return out;
  };

  // GROOT_TEST_GPU=1 runs this on the GPU offload path, which is the one that
  // matters most here: it stages the unselected rows in host RAM, releases them
  // once the first row is sliced, and so depends entirely on the re-read from
  // file that setEmbodiment performs.
  const bool forceCpu = envOrNull("GROOT_TEST_GPU") == nullptr;

  // Reference: the wanted embodiment selected the old way, at load.
  std::vector<float> freshActions;
  std::string defaultTag;
  {
    GrootModel fresh(
        ggufPath, forceCpu, /*backendsDir=*/"", VlaEmbodimentRequest{wantTag});
    ASSERT_EQ(fresh.hparams().num_cameras, wantCams);
    freshActions = runProbe(fresh);
  }

  // The same GGUF loaded once on its default embodiment, then switched.
  GrootModel model(ggufPath, forceCpu, /*backendsDir=*/"");
  defaultTag = model.hparams().selected_embodiment_tag;
  ASSERT_FALSE(defaultTag.empty());
  ASSERT_NE(defaultTag, wantTag);
  const int defaultCams = model.hparams().num_cameras;
  const std::vector<float> defaultActions = runProbe(model);

  model.setEmbodiment(VlaEmbodimentRequest{wantTag});
  EXPECT_EQ(model.hparams().selected_embodiment_tag, wantTag);
  EXPECT_EQ(model.hparams().num_cameras, wantCams);
  const std::vector<float> switchedActions = runProbe(model);

  // Same weights ⇒ same graph over the same input ⇒ the two runs agree to
  // floating-point identity. Gated on cos + relative max-diff rather than
  // bit-exactness so a threaded-CPU reduction-order difference between two
  // model instances can't flake the test.
  ASSERT_EQ(switchedActions.size(), freshActions.size());
  const float cosFresh = cosineSim(
      switchedActions.data(), freshActions.data(), freshActions.size());
  const float relFresh = relMaxDiff(
      switchedActions.data(), freshActions.data(), freshActions.size());
  std::cerr << "[switch] switched-to '" << wantTag
            << "' vs fresh-load: cos=" << cosFresh << " rel=" << relFresh
            << "\n";
  EXPECT_GT(cosFresh, 0.999999f)
      << "switching to '" << wantTag
      << "' did not reproduce a fresh load of that embodiment";
  EXPECT_LT(relFresh, 1e-4f);

  // Negative control: the probe must actually be embodiment-sensitive, else the
  // comparison above would pass even if setEmbodiment did nothing.
  const float cosDefault = cosineSim(
      switchedActions.data(), defaultActions.data(), defaultActions.size());
  std::cerr << "[switch] switched vs default embodiment: cos=" << cosDefault
            << "\n";
  EXPECT_LT(cosDefault, 0.999999f)
      << "the two embodiments produce identical actions — this test cannot "
         "detect a no-op switch";

  // Selecting the same embodiment by numeric id must land on the same row.
  VlaEmbodimentRequest byId;
  byId.cat_id = model.hparams().selected_embodiment_cat_id;
  model.setEmbodiment(VlaEmbodimentRequest{defaultTag});
  model.setEmbodiment(byId);
  EXPECT_EQ(model.hparams().selected_embodiment_tag, wantTag);
  EXPECT_EQ(model.hparams().num_cameras, wantCams);
  const std::vector<float> byIdActions = runProbe(model);
  const float cosById = cosineSim(
      byIdActions.data(), switchedActions.data(), switchedActions.size());
  std::cerr << "[switch] by cat_id vs by tag: cos=" << cosById << "\n";
  EXPECT_GT(cosById, 0.999999f);

  // Round trip: switching back restores the default row exactly.
  model.setEmbodiment(VlaEmbodimentRequest{defaultTag});
  EXPECT_EQ(model.hparams().selected_embodiment_tag, defaultTag);
  EXPECT_EQ(model.hparams().num_cameras, defaultCams);
  const std::vector<float> restoredActions = runProbe(model);
  const float cosRestored = cosineSim(
      restoredActions.data(), defaultActions.data(), defaultActions.size());
  const float relRestored = relMaxDiff(
      restoredActions.data(), defaultActions.data(), defaultActions.size());
  std::cerr << "[switch] restored '" << defaultTag << "': cos=" << cosRestored
            << " rel=" << relRestored << "\n";
  EXPECT_GT(cosRestored, 0.999999f);
  EXPECT_LT(relRestored, 1e-4f);

  // An unknown tag is rejected and leaves the active embodiment untouched.
  EXPECT_THROW(
      model.setEmbodiment(VlaEmbodimentRequest{"definitely-not-an-embodiment"}),
      std::runtime_error);
  EXPECT_EQ(model.hparams().selected_embodiment_tag, defaultTag);
  EXPECT_EQ(model.hparams().num_cameras, defaultCams);

  // So is a cat_id outside the ship set, one outside the id space entirely, and
  // a request naming both spellings.
  VlaEmbodimentRequest bogusId;
  bogusId.cat_id = 9999;
  EXPECT_THROW(model.setEmbodiment(bogusId), std::runtime_error);
  VlaEmbodimentRequest hugeId;
  hugeId.cat_id = 2147483647;
  EXPECT_THROW(model.setEmbodiment(hugeId), std::runtime_error);
  VlaEmbodimentRequest both;
  both.tag = wantTag;
  both.cat_id = 0;
  EXPECT_THROW(model.setEmbodiment(both), std::runtime_error);
  EXPECT_EQ(model.hparams().selected_embodiment_tag, defaultTag);
  EXPECT_EQ(model.hparams().num_cameras, defaultCams);
}
