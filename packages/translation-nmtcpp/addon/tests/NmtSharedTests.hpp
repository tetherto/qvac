#pragma once

#include <filesystem>
#include <string>

#include <gtest/gtest.h>

namespace qvac_lib_inference_addon_nmt::test_shared {

// Non-templated provider holding four function pointers.
class NmtParamProvider {
public:
  using StringFunc = std::string (*)();
  using AnyFunc = std::any (*)();

  NmtParamProvider(
      StringFunc getValidModelPath, StringFunc getInvalidModelPath,
      AnyFunc makeValidInput, AnyFunc makeEmptyInput)
      : getValidModelPath_(getValidModelPath),
        getInvalidModelPath_(getInvalidModelPath),
        makeValidInput_(makeValidInput), makeEmptyInput_(makeEmptyInput) {}

  std::string getValidModelPath() const { return getValidModelPath_(); }
  std::string getInvalidModelPath() const { return getInvalidModelPath_(); }
  std::any makeValidInput() const { return makeValidInput_(); }
  std::any emptyInput() const { return makeEmptyInput_(); }

private:
  StringFunc getValidModelPath_;
  StringFunc getInvalidModelPath_;
  AnyFunc makeValidInput_;
  AnyFunc makeEmptyInput_;
};

// Non-templated GoogleTest fixture parametrized by NmtParamProvider.
class NmtCppModelWrapperTest
    : public ::testing::TestWithParam<NmtParamProvider> {
protected:
  void SetUp() override {
    // Skip test if model file doesn't exist
    std::string modelPath = provider().getValidModelPath();
    if (!std::filesystem::exists(modelPath)) {
      GTEST_SKIP() << "Model not found: " << modelPath << "\n"
                   << "See models/unit-test/README.md for setup instructions.";
    }
  }

  const NmtParamProvider& provider() const {
    return ::testing::TestWithParam<NmtParamProvider>::GetParam();
  }

  std::string getValidModelPath() const {
    return provider().getValidModelPath();
  }
  std::string getInvalidModelPath() const {
    return provider().getInvalidModelPath();
  }
  std::any make_valid_input() const { return provider().makeValidInput(); }
  std::any make_empty_input() const { return provider().emptyInput(); }
};

} // namespace qvac_lib_inference_addon_nmt::test_shared
