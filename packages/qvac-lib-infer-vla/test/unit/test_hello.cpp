#include <gtest/gtest.h>

#include "addon/AddonCpp.hpp"

TEST(HelloWorld, GreetsGivenName) {
  EXPECT_EQ(qvac_lib_infer_vla::HelloWorld::greet("world"), "hello, world");
  EXPECT_EQ(qvac_lib_infer_vla::HelloWorld::greet("qvac"), "hello, qvac");
}
