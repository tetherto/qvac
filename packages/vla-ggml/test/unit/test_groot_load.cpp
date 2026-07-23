// Gates grootLoadModel against a real groot.gguf: all ~1032 tensors map and
// VlaHparamsGeneric is populated correctly. Env-var-gated (GROOT_TEST_GGUF)
// since the ~8.9GB checkpoint is not bundled.

#include <cstdlib>
#include <string>

#include <gtest/gtest.h>

#include "model-interface/groot.hpp"

using qvac_lib_infer_vla_ggml::GrootModel;
using qvac_lib_infer_vla_ggml::VlaHparamsGeneric;

namespace {

std::string envOr(const char* name, const std::string& dflt) {
  const char* v = std::getenv(name);
  return v != nullptr ? std::string(v) : dflt;
}

} // namespace

TEST(GrootLoad, LoadsRealCheckpointAndPopulatesHparams) {
  const std::string ggufPath = envOr("GROOT_TEST_GGUF", "");
  if (ggufPath.empty()) {
    GTEST_SKIP() << "Set GROOT_TEST_GGUF to run this test against a real "
                    "groot.gguf checkpoint.";
  }

  GrootModel model(ggufPath, /*forceCpu=*/true, /*backendsDir=*/"");

  const VlaHparamsGeneric& hp = model.hparams();
  EXPECT_EQ(hp.chunk_size, 40); // action_horizon
  EXPECT_EQ(
      hp.action_dim,
      132); // max_action_dim (padded; real DoF is smaller per-embodiment)
  EXPECT_EQ(hp.max_action_dim, 132);
  EXPECT_EQ(hp.max_state_dim, 132);
  EXPECT_EQ(
      hp.num_cameras, 2); // OXE_DROID: exterior_image_1_left + wrist_image_left
  EXPECT_EQ(hp.state_input_mode, VlaHparamsGeneric::StateInputMode::Continuous);

  EXPECT_EQ(model.backendName(), "CPU");
  EXPECT_FALSE(model.hasGpu());
}
