#include <string>
#include <string_view>
#include <type_traits>

#include <gtest/gtest.h>

#include "inference-addon-cpp/TransparentStringMap.hpp"

namespace qvac_lib_inference_addon_cpp {

namespace {

struct Probe {
  std::string_view value;

  operator std::string_view() const noexcept { return value; }
  operator std::string() const = delete;
};

static_assert(std::is_convertible_v<Probe, std::string_view>);
static_assert(!std::is_convertible_v<Probe, std::string>);

} // namespace

TEST(TransparentStringMap, FindSupportsHeterogeneousKeys) {
  TransparentStringMap<int> map;
  map.emplace("alpha", 1);
  map.emplace("beta", 2);

  const Probe alphaKey{std::string_view{"alpha"}};
  const Probe betaKey{std::string_view{"beta"}};

  auto itSv = map.find(alphaKey);
  ASSERT_NE(itSv, map.end());
  EXPECT_EQ(itSv->second, 1);

  auto itCstr = map.find(betaKey);
  ASSERT_NE(itCstr, map.end());
  EXPECT_EQ(itCstr->second, 2);
}

TEST(TransparentStringMap, ContainsSupportsHeterogeneousKeys) {
  TransparentStringMap<int> map;
  map.emplace("config.device", 7);

  EXPECT_TRUE(map.contains(Probe{std::string_view{"config.device"}}));
  EXPECT_FALSE(map.contains(Probe{std::string_view{"CONFIG.DEVICE"}}));
  EXPECT_FALSE(map.contains(Probe{std::string_view{"missing"}}));
}

TEST(TransparentStringMap, EraseSupportsHeterogeneousKeys) {
  TransparentStringMap<int> map;
  map.emplace("gpu_layers", 999);
  map.emplace("ctx_size", 4096);

  const auto itByView = map.find(Probe{std::string_view{"gpu_layers"}});
  ASSERT_NE(itByView, map.end());
  map.erase(itByView);
  EXPECT_FALSE(map.contains("gpu_layers"));

  const auto itByCstr = map.find(Probe{std::string_view{"ctx_size"}});
  ASSERT_NE(itByCstr, map.end());
  map.erase(itByCstr);
  EXPECT_TRUE(map.empty());
}

} // namespace qvac_lib_inference_addon_cpp

