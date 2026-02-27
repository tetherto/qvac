#include <gmock/gmock.h>
#include <gtest/gtest.h>

#include "qvac-onnx/IOnnxSession.hpp"

using namespace onnx_addon;

// Mock implementation of IOnnxSession for testing virtual dispatch
class MockOnnxSession : public IOnnxSession {
 public:
  explicit MockOnnxSession(std::string path) : path_(std::move(path)) {}

  [[nodiscard]] std::vector<TensorInfo> getInputInfo() const override {
    return inputInfo_;
  }

  [[nodiscard]] std::vector<TensorInfo> getOutputInfo() const override {
    return outputInfo_;
  }

  std::vector<OutputTensor> run(const InputTensor& input) override {
    return run(std::vector<InputTensor>{input});
  }

  std::vector<OutputTensor> run(
      const std::vector<InputTensor>& /*inputs*/) override {
    runCallCount_++;
    return outputs_;
  }

  std::vector<OutputTensor> run(
      const std::vector<InputTensor>& inputs,
      const std::vector<std::string>& /*outputNames*/) override {
    return run(inputs);
  }

  [[nodiscard]] bool isValid() const override { return valid_; }

  [[nodiscard]] const std::string& modelPath() const override { return path_; }

  // Test helpers
  void setValid(bool v) { valid_ = v; }
  void setInputInfo(std::vector<TensorInfo> info) { inputInfo_ = std::move(info); }
  void setOutputInfo(std::vector<TensorInfo> info) {
    outputInfo_ = std::move(info);
  }
  void setOutputs(std::vector<OutputTensor> out) { outputs_ = std::move(out); }
  int runCallCount() const { return runCallCount_; }

 private:
  std::string path_;
  bool valid_ = true;
  std::vector<TensorInfo> inputInfo_;
  std::vector<TensorInfo> outputInfo_;
  std::vector<OutputTensor> outputs_;
  int runCallCount_ = 0;
};

TEST(IOnnxSessionTest, VirtualDispatchModelPath) {
  MockOnnxSession mock("test_model.onnx");
  IOnnxSession& iface = mock;

  EXPECT_EQ(iface.modelPath(), "test_model.onnx");
}

TEST(IOnnxSessionTest, VirtualDispatchIsValid) {
  MockOnnxSession mock("model.onnx");
  IOnnxSession& iface = mock;

  EXPECT_TRUE(iface.isValid());
  mock.setValid(false);
  EXPECT_FALSE(iface.isValid());
}

TEST(IOnnxSessionTest, VirtualDispatchGetInputInfo) {
  MockOnnxSession mock("model.onnx");
  IOnnxSession& iface = mock;

  TensorInfo info;
  info.name = "input_0";
  info.shape = {1, 3, 224, 224};
  info.type = TensorType::FLOAT32;
  mock.setInputInfo({info});

  auto inputs = iface.getInputInfo();
  ASSERT_EQ(inputs.size(), 1);
  EXPECT_EQ(inputs[0].name, "input_0");
  EXPECT_EQ(inputs[0].shape, (std::vector<int64_t>{1, 3, 224, 224}));
  EXPECT_EQ(inputs[0].type, TensorType::FLOAT32);
}

TEST(IOnnxSessionTest, VirtualDispatchGetOutputInfo) {
  MockOnnxSession mock("model.onnx");
  IOnnxSession& iface = mock;

  TensorInfo info;
  info.name = "output_0";
  info.shape = {1, 1000};
  info.type = TensorType::FLOAT32;
  mock.setOutputInfo({info});

  auto outputs = iface.getOutputInfo();
  ASSERT_EQ(outputs.size(), 1);
  EXPECT_EQ(outputs[0].name, "output_0");
  EXPECT_EQ(outputs[0].shape, (std::vector<int64_t>{1, 1000}));
}

TEST(IOnnxSessionTest, VirtualDispatchRunSingleInput) {
  MockOnnxSession mock("model.onnx");
  IOnnxSession& iface = mock;

  OutputTensor out;
  out.name = "Y";
  out.shape = {1, 4};
  out.type = TensorType::FLOAT32;
  out.data.resize(4 * sizeof(float));
  mock.setOutputs({out});

  float data[] = {1.0f, 2.0f, 3.0f, 4.0f};
  InputTensor input{
      .name = "X",
      .shape = {1, 4},
      .type = TensorType::FLOAT32,
      .data = data,
      .dataSize = sizeof(data)};

  auto results = iface.run(input);
  ASSERT_EQ(results.size(), 1);
  EXPECT_EQ(results[0].name, "Y");
  EXPECT_EQ(mock.runCallCount(), 1);
}

TEST(IOnnxSessionTest, VirtualDispatchRunMultipleInputs) {
  MockOnnxSession mock("model.onnx");
  IOnnxSession& iface = mock;
  mock.setOutputs({});

  float data[] = {1.0f};
  std::vector<InputTensor> inputs = {
      {.name = "A",
       .shape = {1},
       .type = TensorType::FLOAT32,
       .data = data,
       .dataSize = sizeof(float)},
      {.name = "B",
       .shape = {1},
       .type = TensorType::FLOAT32,
       .data = data,
       .dataSize = sizeof(float)}};

  iface.run(inputs);
  EXPECT_EQ(mock.runCallCount(), 1);
}

TEST(IOnnxSessionTest, VirtualDispatchRunWithOutputNames) {
  MockOnnxSession mock("model.onnx");
  IOnnxSession& iface = mock;
  mock.setOutputs({});

  float data[] = {1.0f};
  std::vector<InputTensor> inputs = {
      {.name = "X",
       .shape = {1},
       .type = TensorType::FLOAT32,
       .data = data,
       .dataSize = sizeof(float)}};

  iface.run(inputs, {"output_0"});
  EXPECT_EQ(mock.runCallCount(), 1);
}

TEST(IOnnxSessionTest, PolymorphicDeletion) {
  // Ensure deleting through base pointer works (virtual destructor)
  auto* mock = new MockOnnxSession("model.onnx");
  IOnnxSession* iface = mock;
  delete iface;  // Should not leak
}

TEST(IOnnxSessionTest, MultipleImplementations) {
  MockOnnxSession mock1("model_a.onnx");
  MockOnnxSession mock2("model_b.onnx");

  std::vector<IOnnxSession*> sessions = {&mock1, &mock2};

  EXPECT_EQ(sessions[0]->modelPath(), "model_a.onnx");
  EXPECT_EQ(sessions[1]->modelPath(), "model_b.onnx");
}
