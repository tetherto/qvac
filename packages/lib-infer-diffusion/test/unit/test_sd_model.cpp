#include <gtest/gtest.h>

#include "model-interface/SdModel.hpp"
#include "test_common.hpp"

using namespace qvac_lib_inference_addon_sd;

class SdModelTest : public ::testing::Test {};

TEST_F(SdModelTest, ConstructWithEmptyConfigDoesNotThrow) {
  SdCtxConfig config{};
  EXPECT_NO_THROW(SdModel model(std::move(config)));
}

TEST_F(SdModelTest, IsNotLoadedAfterConstruction) {
  SdCtxConfig config{};
  SdModel model(std::move(config));
  EXPECT_FALSE(model.isLoaded());
}

TEST_F(SdModelTest, GetNameReturnsSdModel) {
  SdCtxConfig config{};
  SdModel model(std::move(config));
  EXPECT_EQ(model.getName(), "SdModel");
}

TEST_F(SdModelTest, DestroyUnloadedModelIsNoop) {
  SdCtxConfig config{};
  // Destructor on a never-loaded model must not crash.
  EXPECT_NO_THROW({ SdModel model(std::move(config)); });
}
