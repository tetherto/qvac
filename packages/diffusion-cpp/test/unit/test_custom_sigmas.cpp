#include <cmath>
#include <iterator>
#include <limits>

#include <gtest/gtest.h>

#include "handlers/SdGenHandlers.hpp"

using namespace qvac_lib_inference_addon_sd;
using qvac_errors::StatusError;

namespace {
picojson::value sigmas(std::initializer_list<double> values) {
  picojson::array array;
  for (double value : values) {
    // PicoJSON rejects NaN and infinity in its numeric constructor. Assign
    // through the numeric accessor so those fixtures reach our validation.
    array.emplace_back(0.0);
    array.back().get<double>() = value;
  }
  return picojson::value(array);
}

SdGenConfig parse(const picojson::value& values) {
  SdGenConfig config;
  applySdGenHandlers(config, {{"custom_sigmas", values}});
  return config;
}
} // namespace

TEST(CustomSigmas, TurboScheduleOverridesSteps) {
  SdGenConfig config;
  applySdGenHandlers(
      config,
      {{"steps", picojson::value(30.0)},
       {"custom_sigmas",
        sigmas(
            {1.0,
             0.978453,
             0.95418,
             0.926626,
             0.89508,
             0.845148,
             0.704534,
             0.414568,
             0.0})}});
  EXPECT_EQ(config.steps, 8);
  ASSERT_EQ(config.customSigmas.size(), 9u);
  EXPECT_FLOAT_EQ(config.customSigmas[1], 0.978453f);
  EXPECT_FLOAT_EQ(config.customSigmas.back(), 0.0f);
}

TEST(CustomSigmas, OmittedSchedulePreservesOrdinarySampling) {
  SdGenConfig config;
  applySdGenHandlers(config, {{"steps", picojson::value(30.0)}});
  EXPECT_EQ(config.steps, 30);
  EXPECT_TRUE(config.customSigmas.empty());
}

TEST(CustomSigmas, AcceptsOneStepAndSigmasAboveOne) {
  const auto config = parse(sigmas({14.0, 0.0}));
  EXPECT_EQ(config.steps, 1);
  EXPECT_FLOAT_EQ(config.customSigmas.front(), 14.0f);
}

TEST(CustomSigmas, RejectsMalformedSchedules) {
  const picojson::value invalid[] = {
      picojson::value(),
      picojson::value(true),
      picojson::value(1.0),
      picojson::value(std::string("1,0")),
      sigmas({}),
      sigmas({0.0}),
      sigmas({1.0, 0.5}),
      sigmas({0.0, 0.0}),
      sigmas({1.0, 1.0, 0.0}),
      sigmas({0.5, 1.0, 0.0}),
      sigmas({1.0, -0.1, 0.0}),
      sigmas({std::numeric_limits<double>::infinity(), 0.0}),
      sigmas({std::numeric_limits<double>::quiet_NaN(), 0.0}),
      sigmas({std::numeric_limits<double>::max(), 0.0}),
      sigmas({1.0, std::nextafter(1.0, 0.0), 0.0}),
      sigmas({1.0, std::numeric_limits<double>::denorm_min(), 0.0}),
      picojson::value(
          picojson::array{
              picojson::value(std::string("1")), picojson::value(0.0)})};
  for (size_t i = 0; i < std::size(invalid); ++i) {
    SCOPED_TRACE(i);
    EXPECT_THROW(parse(invalid[i]), StatusError);
  }
}

TEST(CustomSigmas, ConfigCopiesOwnTheirSchedule) {
  auto original = parse(sigmas({1.0, 0.5, 0.0}));
  auto copy = original;
  original.customSigmas[1] = 0.25f;
  EXPECT_FLOAT_EQ(copy.customSigmas[1], 0.5f);
}
