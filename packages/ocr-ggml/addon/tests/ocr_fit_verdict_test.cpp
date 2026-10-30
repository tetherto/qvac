#include <vector>

#include <gtest/gtest.h>

#include "model-interface/OcrFit.hpp"

using qvac_lib_infer_ocr_ggml::ocr_fit::capToAppLimit;
using qvac_lib_infer_ocr_ggml::ocr_fit::FitDevice;
using qvac_lib_infer_ocr_ggml::ocr_fit::ocrVerdict;

namespace {
FitDevice row(bool unified, uint64_t usedBytes, uint64_t freeBytes) {
  return {"id", "name", unified, usedBytes, freeBytes, freeBytes};
}
} // namespace

TEST(OcrFitVerdict, FitsWhenTheUpperBoundFitsEveryRow) {
  const std::vector<FitDevice> rows{row(false, 600, 1000), row(true, 600, 900)};
  EXPECT_EQ(ocrVerdict(rows, 100, 200, false), "fits");
}

TEST(OcrFitVerdict, AHostRowWithoutRoomDoesNotYieldAFit) {
  const std::vector<FitDevice> rows{row(false, 600, 1000), row(true, 600, 700)};
  EXPECT_EQ(ocrVerdict(rows, 100, 200, false), "unknown");
}

TEST(OcrFitVerdict, TheCpuDoesNotFitWhenTheSourceTensorsDoNot) {
  const std::vector<FitDevice> rows{row(true, 600, 400)};
  EXPECT_EQ(ocrVerdict(rows, 300, 200, true), "does-not-fit");
  EXPECT_EQ(ocrVerdict(rows, 150, 200, true), "unknown");
}

TEST(OcrFitVerdict, AnExhaustedAppLimitIsDoesNotFitOnTheCpu) {
  std::vector<FitDevice> rows{row(true, 600, 8000)};
  capToAppLimit(rows, 0);
  EXPECT_EQ(rows.front().freeBytes, 0U);
  EXPECT_EQ(ocrVerdict(rows, 100, 0, true), "does-not-fit");
}

TEST(OcrFitVerdict, TheAppLimitAndTheMarginBindAUnifiedFit) {
  std::vector<FitDevice> rows{row(true, 600, 8000), row(true, 0, 8000)};
  EXPECT_EQ(ocrVerdict(rows, 100, 200, false), "fits");
  capToAppLimit(rows, 700);
  EXPECT_EQ(rows[0].freeBytes, 700U);
  EXPECT_EQ(rows[1].freeBytes, 700U);
  EXPECT_EQ(ocrVerdict(rows, 100, 200, false), "unknown");
}

TEST(OcrFitVerdict, TheAppLimitLeavesADiscreteRowAlone) {
  std::vector<FitDevice> rows{row(false, 600, 8000), row(true, 600, 8000)};
  capToAppLimit(rows, 700);
  EXPECT_EQ(rows[0].freeBytes, 8000U);
  EXPECT_EQ(rows[1].freeBytes, 700U);
}
