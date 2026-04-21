#include <gtest/gtest.h>

#include "addon/AddonCpp.hpp"

TEST(HelloWorld, GreetsGivenName) {
  EXPECT_EQ({{CPP_NAMESPACE}}::HelloWorld::greet("world"), "hello, world");
  EXPECT_EQ({{CPP_NAMESPACE}}::HelloWorld::greet("qvac"), "hello, qvac");
}
