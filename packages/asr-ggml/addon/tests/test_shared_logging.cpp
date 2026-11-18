#include <ggml.h>
#include <gtest/gtest.h>
#include <parakeet/log.h>
#include <whisper.h>

namespace {

void runtimeLog(ggml_log_level, const char*, void*) {}
void speechLog(ggml_log_level, const char*, void*) {}

class SharedLogging : public ::testing::Test {
protected:
  void SetUp() override {
    ggml_log_get(&previousCallback_, &previousData_);
    ggml_log_set(runtimeLog, this);
  }

  void TearDown() override {
    whisper_log_set(nullptr, nullptr);
    parakeet_log_set(nullptr, nullptr);
    ggml_log_set(previousCallback_, previousData_);
  }

  void expectRuntimeCallback() {
    ggml_log_callback callback = nullptr;
    void* data = nullptr;
    ggml_log_get(&callback, &data);
    EXPECT_EQ(callback, runtimeLog);
    EXPECT_EQ(data, this);
  }

private:
  ggml_log_callback previousCallback_ = nullptr;
  void* previousData_ = nullptr;
};

TEST_F(SharedLogging, WhisperThenParakeetPreservesRuntimeCallback) {
  whisper_log_set(speechLog, nullptr);
  parakeet_log_set(speechLog, nullptr);
  expectRuntimeCallback();
}

TEST_F(SharedLogging, ParakeetThenWhisperPreservesRuntimeCallback) {
  parakeet_log_set(speechLog, nullptr);
  whisper_log_set(speechLog, nullptr);
  expectRuntimeCallback();
}

TEST_F(SharedLogging, ResettingSpeechCallbacksPreservesRuntimeCallback) {
  whisper_log_set(speechLog, nullptr);
  parakeet_log_set(speechLog, nullptr);
  whisper_log_set(nullptr, nullptr);
  parakeet_log_set(nullptr, nullptr);
  expectRuntimeCallback();
}

} // namespace
