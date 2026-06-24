#include <gtest/gtest.h>

#include "addon/TTSErrors.hpp"
#include "model-interface/BackendUtils.hpp"

using qvac::ttsggml::backendDeviceCode;
using qvac::ttsggml::backendIdFromName;
using qvac_errors::createTTSError;
using qvac_errors::tts_error::TTSAddonId;
using qvac_errors::tts_error::TTSErrorCode;
using qvac_errors::tts_error::toString;

TEST(BackendUtils, BackendIdCpu) {
  EXPECT_EQ(backendIdFromName("CPU"), 0);
}

TEST(BackendUtils, BackendIdMetalPrefix) {
  EXPECT_EQ(backendIdFromName("Metal"), 1);
  EXPECT_EQ(backendIdFromName("Metal-A17"), 1);
  EXPECT_EQ(backendIdFromName("MTL"), 1);
  EXPECT_EQ(backendIdFromName("MTL_M3_Ultra"), 1);
}

TEST(BackendUtils, BackendIdCudaPrefix) {
  EXPECT_EQ(backendIdFromName("CUDA"), 2);
  EXPECT_EQ(backendIdFromName("CUDA0"), 2);
  EXPECT_EQ(backendIdFromName("CUDA_RTX4090"), 2);
}

TEST(BackendUtils, BackendIdVulkanPrefix) {
  EXPECT_EQ(backendIdFromName("Vulkan"), 3);
  EXPECT_EQ(backendIdFromName("Vulkan0"), 3);
  EXPECT_EQ(backendIdFromName("Vulkan_AMD_RX_7600_XT"), 3);
}

TEST(BackendUtils, BackendIdOpenClPrefix) {
  EXPECT_EQ(backendIdFromName("OpenCL"), 4);
  EXPECT_EQ(backendIdFromName("OpenCL_Adreno_750"), 4);
}

TEST(BackendUtils, BackendIdUnknownReturnsSentinel) {
  EXPECT_EQ(backendIdFromName(""), 99);
  EXPECT_EQ(backendIdFromName("ZLUDA"), 99);
  EXPECT_EQ(backendIdFromName("cpu"), 99) << "case-sensitive: lowercase 'cpu' is not the CPU backend";
  EXPECT_EQ(backendIdFromName("Metalorama"), 1) << "rfind(prefix, 0) only checks at start";
}

TEST(BackendUtils, BackendDeviceCodeMatchesGgmlEnum) {
  EXPECT_EQ(backendDeviceCode(tts_cpp::BackendDevice::CPU), 0);
  EXPECT_EQ(backendDeviceCode(tts_cpp::BackendDevice::GPU), 1);
}

TEST(TTSErrors, ToStringCoversAllKnownCodes) {
  EXPECT_EQ(toString(TTSErrorCode::OK), "OK");
  EXPECT_EQ(toString(TTSErrorCode::ModelNotLoaded), "ModelNotLoaded");
  EXPECT_EQ(toString(TTSErrorCode::ModelFileNotFound), "ModelFileNotFound");
  EXPECT_EQ(toString(TTSErrorCode::ConfigFileNotFound), "ConfigFileNotFound");
  EXPECT_EQ(toString(TTSErrorCode::InvalidAPI), "InvalidAPI");
  EXPECT_EQ(toString(TTSErrorCode::InitializationFailed), "InitializationFailed");
  EXPECT_EQ(toString(TTSErrorCode::SynthesisFailed), "SynthesisFailed");
}

TEST(TTSErrors, ToStringFallsBackForUnknownCodes) {
  EXPECT_EQ(toString(7), "UnknownTTSError");
  EXPECT_EQ(toString(99), "UnknownTTSError");
  EXPECT_EQ(toString(0xDEADBEEF), "UnknownTTSError");
}

TEST(TTSErrors, CreateTTSErrorTagsErrorWithTTSAddonId) {
  const auto err = createTTSError(TTSErrorCode::ModelFileNotFound,
                                  "missing model.gguf");
  const std::string code = err.codeString();
  EXPECT_NE(code.find(std::string(TTSAddonId)), std::string::npos)
      << "codeString should embed addonId; got: " << code;
  EXPECT_NE(code.find("ModelFileNotFound"), std::string::npos)
      << "codeString should embed local code; got: " << code;
  EXPECT_NE(std::string(err.what()).find("missing model.gguf"),
            std::string::npos);
  EXPECT_FALSE(err.isJSError());
}

TEST(TTSErrors, CreateTTSErrorWithUnknownCodeFallsBack) {
  const auto err = createTTSError(static_cast<TTSErrorCode>(123), "oops");
  const std::string code = err.codeString();
  EXPECT_NE(code.find("UnknownTTSError"), std::string::npos)
      << "codeString should embed UnknownTTSError fallback; got: " << code;
  EXPECT_NE(std::string(err.what()).find("oops"), std::string::npos);
}
