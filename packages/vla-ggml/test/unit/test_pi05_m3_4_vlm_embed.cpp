// M3.4 parity test: PaliGemma embedder + sqrt(hidden) scaling.
//
// Loads `vlm.embed_tokens` from pi05_base.gguf, looks up the fixture's
// 200 prompt tokens, scales by sqrt(2048), and asserts against
// `vlm.embed_out` from the PyTorch reference.

#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

#include <ggml.h>
#include <gguf.h>
#include <gtest/gtest.h>

#include "model-interface/pi05.hpp"
#include "pi05_compute.hpp"
#include "utils/safetensors_lite.hpp"

namespace {

constexpr int TOKEN_MAX_LEN = 200;
constexpr int HIDDEN = 2048;

const char* envOrNull(const char* name) {
  const char* v = std::getenv(name);
  return (v != nullptr && v[0] != '\0') ? v : nullptr;
}

float cosineSim(const float* a, const float* b, size_t n) {
  double dot = 0.0;
  double na = 0.0;
  double nb = 0.0;
  for (size_t i = 0; i < n; ++i) {
    dot += static_cast<double>(a[i]) * static_cast<double>(b[i]);
    na += static_cast<double>(a[i]) * static_cast<double>(a[i]);
    nb += static_cast<double>(b[i]) * static_cast<double>(b[i]);
  }
  const double denom = std::sqrt(na) * std::sqrt(nb);
  return denom > 0.0 ? static_cast<float>(dot / denom) : 0.0f;
}

float maxAbsDiff(const float* a, const float* b, size_t n) {
  float m = 0.0f;
  for (size_t i = 0; i < n; ++i) {
    const float d = std::fabs(a[i] - b[i]);
    if (d > m) {
      m = d;
    }
  }
  return m;
}

} // namespace

TEST(Pi05M3_4, VlmEmbedMatchesPytorch) {
  const char* gguf_path = envOrNull("PI05_TEST_GGUF");
  const char* fixture_path = envOrNull("PI05_TEST_FIXTURE");
  const char* activations_path = envOrNull("PI05_TEST_ACTIVATIONS");
  if (gguf_path == nullptr || fixture_path == nullptr ||
      activations_path == nullptr) {
    GTEST_SKIP() << "Set PI05_TEST_GGUF, PI05_TEST_FIXTURE and "
                    "PI05_TEST_ACTIVATIONS to run the M3.4 parity test.";
  }

  // ── 1. Fixture tokens + expected embedding output. ────────────────────
  qvac_vla_safetensors_lite::Reader fixture;
  qvac_vla_safetensors_lite::Reader activations;
  ASSERT_NO_THROW(fixture.open(fixture_path));
  ASSERT_NO_THROW(activations.open(activations_path));

  // Tokens are stored as I32 in the fixture. safetensors_lite reads F32
  // by API, so we copy the raw bytes via the record.
  const auto& tok_record = fixture.record("fixture.tokens");
  ASSERT_EQ(tok_record.dtype, "I32");
  ASSERT_EQ(
      tok_record.byte_length,
      static_cast<uint64_t>(TOKEN_MAX_LEN * sizeof(int32_t)));
  std::vector<int32_t> tokens(TOKEN_MAX_LEN);
  // Re-open the fixture as a byte stream to fetch the raw int32 blob.
  // (safetensors_lite only exposes readF32; for the test it's simpler to
  // re-read the file region than to add an int32 path to the reader.)
  {
    std::ifstream in(fixture_path, std::ios::binary);
    ASSERT_TRUE(in);
    uint64_t header_len = 0;
    in.read(reinterpret_cast<char*>(&header_len), 8);
    in.seekg(
        8 + static_cast<std::streamoff>(header_len) +
            static_cast<std::streamoff>(tok_record.byte_offset),
        std::ios::beg);
    in.read(reinterpret_cast<char*>(tokens.data()), tok_record.byte_length);
    ASSERT_TRUE(in);
  }

  const std::vector<float> expected = activations.readF32("vlm.embed_out");
  ASSERT_EQ(expected.size(), static_cast<size_t>(TOKEN_MAX_LEN * HIDDEN));

  // ── 2. Load the embedding matrix from the GGUF. ───────────────────────
  struct ggml_context* ctx_w = nullptr;
  struct gguf_init_params gguf_params{};
  gguf_params.no_alloc = false;
  gguf_params.ctx = &ctx_w;
  struct gguf_context* gguf = gguf_init_from_file(gguf_path, gguf_params);
  ASSERT_NE(gguf, nullptr);
  ASSERT_NE(ctx_w, nullptr);

  struct ggml_tensor* embed_tokens = ggml_get_tensor(ctx_w, "vlm.embed_tokens");
  ASSERT_NE(embed_tokens, nullptr);
  EXPECT_EQ(embed_tokens->ne[0], HIDDEN);

  // ── 3. Build the M3.4 graph. ──────────────────────────────────────────
  const size_t graph_ctx_mem = 32u * 1024u * 1024u;
  std::vector<uint8_t> graph_mem(graph_ctx_mem);
  struct ggml_init_params gp{
      /*.mem_size   =*/graph_ctx_mem,
      /*.mem_buffer =*/graph_mem.data(),
      /*.no_alloc   =*/false,
  };
  struct ggml_context* ctx_g = ggml_init(gp);
  ASSERT_NE(ctx_g, nullptr);

  struct ggml_tensor* tok_t =
      ggml_new_tensor_1d(ctx_g, GGML_TYPE_I32, TOKEN_MAX_LEN);
  std::memcpy(tok_t->data, tokens.data(), tokens.size() * sizeof(int32_t));

  using qvac_lib_infer_vla_ggml::pi05BuildVlmEmbedGraph;
  struct ggml_tensor* out =
      pi05BuildVlmEmbedGraph(ctx_g, tok_t, embed_tokens, HIDDEN);
  ASSERT_NE(out, nullptr);

  struct ggml_cgraph* gf = ggml_new_graph(ctx_g);
  ggml_build_forward_expand(gf, out);
  ASSERT_EQ(pi05_test::computeGraphCpu(gf), GGML_STATUS_SUCCESS);

  // ── 4. Compare. ───────────────────────────────────────────────────────
  ASSERT_EQ(ggml_nelements(out), static_cast<int64_t>(TOKEN_MAX_LEN * HIDDEN));
  const float* got = static_cast<const float*>(out->data);
  const float cos = cosineSim(got, expected.data(), expected.size());
  const float diff = maxAbsDiff(got, expected.data(), expected.size());

  float max_abs_expected = 0.0f;
  for (size_t i = 0; i < expected.size(); ++i) {
    const float a = std::fabs(expected[i]);
    if (a > max_abs_expected) {
      max_abs_expected = a;
    }
  }
  std::cerr << "[M3.4] embed_out: cos=" << cos << " max_abs_diff=" << diff
            << " max_abs_expected=" << max_abs_expected
            << " rel_max=" << (diff / std::max(max_abs_expected, 1e-9f))
            << "\n";

  // Q8_0 embed table lookup + scalar multiply. Observed rel_max ~0.0038
  // across hardware; bar gives ~2× headroom.
  EXPECT_GT(cos, 0.9999f);
  EXPECT_LT(diff / std::max(max_abs_expected, 1e-9f), 0.01f);

  ggml_free(ctx_g);
  gguf_free(gguf);
  ggml_free(ctx_w);
}
