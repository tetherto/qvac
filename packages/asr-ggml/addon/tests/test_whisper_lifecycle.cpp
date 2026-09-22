#include <cstdlib>
#include <filesystem>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

#include <ggml-backend.h>
#include <gtest/gtest.h>

#include "model-interface/WhisperGpuSelection.hpp"
#include "model-interface/whisper/WhisperModel.hpp"

namespace {
using qvac::asrggml::whisper::WhisperConfig;
using qvac::asrggml::whisper::WhisperModel;

class CaptureModelLoads {
public:
  CaptureModelLoads() : previous_(std::cout.rdbuf(output_.rdbuf())) {}
  ~CaptureModelLoads() { std::cout.rdbuf(previous_); }

  size_t completed() const {
    const std::string text = output_.str();
    const std::string marker = "Whisper model loaded successfully";
    size_t count = 0;
    size_t offset = 0;
    while ((offset = text.find(marker, offset)) != std::string::npos) {
      ++count;
      offset += marker.size();
    }
    return count;
  }

private:
  std::ostringstream output_;
  std::streambuf* previous_;
};

class WhisperModelLifecycleTest : public ::testing::TestWithParam<const char*> {
protected:
  void SetUp() override {
    const char* modelPath = std::getenv("QVAC_TEST_WHISPER_MODEL");
    config_.whisperContextCfg["model"] = std::string(
        modelPath != nullptr ? modelPath : "../../../models/ggml-tiny.bin");
    ASSERT_TRUE(std::filesystem::exists(
        std::get<std::string>(config_.whisperContextCfg.at("model"))))
        << "Stage ggml-tiny.bin or set QVAC_TEST_WHISPER_MODEL";
    config_.whisperContextCfg["use_gpu"] = false;
    config_.whisperMainCfg["n_threads"] = 2.0;
    config_.whisperMainCfg["language"] = std::string("en");
    WhisperModel bootstrap(config_);
    ASSERT_NO_THROW(bootstrap.load());
    ASSERT_TRUE(bootstrap.isLoaded());
    devices_ = main_gpu::registryDevices();
    config_.whisperContextCfg["use_gpu"] = true;
  }

  ggml_backend_dev_t classDevice(bool integrated) const {
    ggml_backend_dev_t first = nullptr;
    for (size_t i = 0; i < devices_.size(); ++i) {
      const auto& device = devices_[i];
      if (!device.eligible || device.integrated != integrated) {
        continue;
      }
      if (device.adrenoOpencl) {
        return ggml_backend_dev_get(i);
      }
      if (first == nullptr) {
        first = ggml_backend_dev_get(i);
      }
    }
    return first;
  }

  static void
  expectBackend(const WhisperModel& model, ggml_backend_dev_t expected) {
    ASSERT_TRUE(model.isLoaded());
    EXPECT_EQ(model.getBackendDeviceClass(), expected != nullptr ? 1 : 0);
    if (expected == nullptr) {
      EXPECT_EQ(model.getBackendId(), 0);
      EXPECT_EQ(model.getBackendName(), "CPU");
    } else {
      EXPECT_NE(model.getBackendId(), 0);
      EXPECT_EQ(
          model.getBackendName(),
          ggml_backend_reg_name(ggml_backend_dev_backend_reg(expected)));
      EXPECT_EQ(
          model.getBackendDescription(),
          ggml_backend_dev_description(expected));
    }
  }

  WhisperConfig config_;
  std::vector<main_gpu::Device> devices_;
};

TEST_P(WhisperModelLifecycleTest, RawGpuIndicesReachNativeInitialization) {
  size_t tested = 0;
  for (size_t i = 0; i < devices_.size(); ++i) {
    if (!devices_[i].eligible) {
      continue;
    }
    SCOPED_TRACE(i);
    config_.whisperContextCfg[GetParam()] = static_cast<int>(i);
    CaptureModelLoads loads;
    WhisperModel model(config_);
    ASSERT_NO_THROW(model.load());
    EXPECT_EQ(loads.completed(), 1U);
    expectBackend(model, ggml_backend_dev_get(i));
    ++tested;
  }
  if (tested == 0) {
    GTEST_SKIP() << "No eligible GPU in the native registry";
  }
}

TEST_P(WhisperModelLifecycleTest, RawCpuIndexLoadsNativeCpuFallback) {
  for (size_t i = 0; i < devices_.size(); ++i) {
    const auto device = ggml_backend_dev_get(i);
    if (device == nullptr ||
        ggml_backend_dev_type(device) != GGML_BACKEND_DEVICE_TYPE_CPU) {
      continue;
    }
    config_.whisperContextCfg[GetParam()] = static_cast<int>(i);
    CaptureModelLoads loads;
    WhisperModel model(config_);
    ASSERT_NO_THROW(model.load());
    EXPECT_EQ(loads.completed(), 1U);
    expectBackend(model, nullptr);
    return;
  }
  FAIL() << "Native registry has no CPU device";
}

TEST_P(WhisperModelLifecycleTest, ClassSelectorsReachNativeInitialization) {
  for (const bool integrated : {false, true}) {
    const std::string selector = integrated ? "integrated" : "dedicated";
    SCOPED_TRACE(selector);
    config_.whisperContextCfg[GetParam()] = selector;
    CaptureModelLoads loads;
    WhisperModel model(config_);
    ASSERT_NO_THROW(model.load());
    EXPECT_EQ(loads.completed(), 1U);
    expectBackend(model, classDevice(integrated));
  }
}

TEST_P(WhisperModelLifecycleTest, SetConfigRecreatesOnlyChangedContexts) {
  CaptureModelLoads loads;
  WhisperModel model(config_);
  ASSERT_NO_THROW(model.load());
  ASSERT_EQ(loads.completed(), 1U);
  const auto defaultName = model.getBackendName();
  const auto defaultDescription = model.getBackendDescription();
  const auto defaultClass = model.getBackendDeviceClass();

  config_.whisperContextCfg[GetParam()] = std::string("integrated");
  ASSERT_NO_THROW(model.setConfig(config_));
  EXPECT_EQ(loads.completed(), 2U);
  expectBackend(model, classDevice(true));

  config_.whisperContextCfg[GetParam()] = std::string("dedicated");
  ASSERT_NO_THROW(model.setConfig(config_));
  EXPECT_EQ(loads.completed(), 3U);
  expectBackend(model, classDevice(false));

  ASSERT_NO_THROW(model.setConfig(config_));
  EXPECT_EQ(loads.completed(), 3U);
  expectBackend(model, classDevice(false));

  config_.whisperContextCfg.erase(GetParam());
  ASSERT_NO_THROW(model.setConfig(config_));
  EXPECT_EQ(loads.completed(), 4U);
  EXPECT_TRUE(model.isLoaded());
  EXPECT_EQ(model.getBackendDeviceClass(), defaultClass);
  EXPECT_EQ(model.getBackendName(), defaultName);
  EXPECT_EQ(model.getBackendDescription(), defaultDescription);

  ASSERT_NO_THROW(model.reload());
  EXPECT_EQ(loads.completed(), 5U);
  EXPECT_TRUE(model.isLoaded());
  EXPECT_EQ(model.getBackendName(), defaultName);
  EXPECT_EQ(model.getBackendDescription(), defaultDescription);
}

INSTANTIATE_TEST_SUITE_P(
    SelectorAliases, WhisperModelLifecycleTest,
    ::testing::Values("main-gpu", "main_gpu"));
} // namespace
