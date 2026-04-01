#include <optional>
#include <utility>

#include <gtest/gtest.h>

#include "qvac-lib-inference-addon-cpp/Utils.hpp"

namespace qvac_lib_inference_addon_cpp::utils {

TEST(Utils, OnExit) {
  bool flag = false;
  auto set_flag = [&flag]() { flag = true; };

  {
    OnExit on_exit(std::move(set_flag));
    EXPECT_FALSE(flag);
  }

  EXPECT_TRUE(flag);
}

TEST(Utils, OnError) {
  bool flag = false;
  auto set_flag = [&flag]() { flag = true; };

  try {
    OnError on_error(std::move(set_flag));
    EXPECT_FALSE(flag);
    throw std::runtime_error("test exception");
  } catch (const std::exception& e) {
  }

  // `on_error` was called while stack unwinding was in progress
  EXPECT_TRUE(flag);
}

} // namespace qvac_lib_inference_addon_cpp::utils
