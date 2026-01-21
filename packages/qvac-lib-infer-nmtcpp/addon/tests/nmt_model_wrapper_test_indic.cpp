#include <algorithm>
#include <cmath>
#include <cstring>
#include <filesystem>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <vector>

#include <gmock/gmock.h>
#include <gtest/gtest.h>
#include <qvac-lib-inference-addon-cpp/Errors.hpp>

#include "../src/model-interface/TranslationModel.hpp"
#include "NmtSharedTests.hpp"

using qvac_lib_inference_addon_mlc_marian::TranslationModel;

namespace qvac_lib_inference_addon_nmt::test_indic {

std::string getValidModelPath();

std::string getInvalidModelPath();

std::string make_valid_input();

std::string make_empty_input();

// ============================================================================
// Generic Model API Tests
// ============================================================================

// Type definitions for generic API tests
using TestModel = TranslationModel;

std::string getValidModelPath() {
  namespace fs = std::filesystem;
  // Try different possible paths for models
  if (fs::exists(fs::path{"../../../models/unit-test/ggml-indictrans2-en-indic-dist-200M-q4_0.bin"})) {
    return "../../../models/unit-test/ggml-indictrans2-en-indic-dist-200M-q4_0.bin";
  }
  return "models/unit-test/ggml-indictrans2-en-indic-dist-200M-q4_0.bin";
}

std::string getInvalidModelPath() {
  return "definitely/invalid/path/model.bin";
}

TestModel make_valid_model() {
  return TranslationModel(getValidModelPath());
}

TestModel make_invalid_model() { return TranslationModel(); }

std::string make_valid_input() { return "Hello, my name is Bob."; }

std::string make_empty_input() { return std::string(); }

}; // namespace qvac_lib_inference_addon_nmt::test_indic

using qvac_lib_inference_addon_nmt::test_shared::NmtCppModelWrapperTest;
using qvac_lib_inference_addon_nmt::test_shared::NmtParamProvider;

INSTANTIATE_TEST_SUITE_P(
    IndicTests, NmtCppModelWrapperTest,
    ::testing::Values(NmtParamProvider(
        qvac_lib_inference_addon_nmt::test_indic::getValidModelPath,
        qvac_lib_inference_addon_nmt::test_indic::getInvalidModelPath,
        qvac_lib_inference_addon_nmt::test_indic::make_valid_input,
        qvac_lib_inference_addon_nmt::test_indic::make_empty_input)));
