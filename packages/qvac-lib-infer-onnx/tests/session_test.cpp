#include <gtest/gtest.h>

#include <cmath>
#include <filesystem>
#include <string>
#include <vector>

#include "qvac-onnx/OnnxSession.hpp"

// Do not use "using namespace onnx_addon" because ORT C API defines a global
// GraphOptimizationLevel typedef that collides with onnx_addon's.
namespace oa = onnx_addon;

// Resolve fixture paths relative to the test source directory.
// CMAKE_CURRENT_SOURCE_DIR is passed via -D at compile time.
#ifndef TEST_FIXTURES_DIR
#error "TEST_FIXTURES_DIR must be defined at compile time"
#endif

static std::string fixturePath(const std::string& name) {
  return std::string(TEST_FIXTURES_DIR) + "/" + name;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

TEST(OnnxSessionTest, ConstructWithIdentityModel) {
  oa::OnnxSession session(fixturePath("identity.onnx"),
                      {.provider = oa::ExecutionProvider::CPU});
  EXPECT_TRUE(session.isValid());
}

TEST(OnnxSessionTest, ModelPathIsStored) {
  auto path = fixturePath("identity.onnx");
  oa::OnnxSession session(path, {.provider = oa::ExecutionProvider::CPU});
  EXPECT_EQ(session.modelPath(), path);
}

TEST(OnnxSessionTest, InvalidPathThrows) {
  EXPECT_THROW(oa::OnnxSession("/nonexistent/model.onnx",
                            {.provider = oa::ExecutionProvider::CPU}),
               Ort::Exception);
}

TEST(OnnxSessionTest, MoveConstruction) {
  oa::OnnxSession original(fixturePath("identity.onnx"),
                        {.provider = oa::ExecutionProvider::CPU});
  ASSERT_TRUE(original.isValid());

  oa::OnnxSession moved(std::move(original));
  EXPECT_TRUE(moved.isValid());
  EXPECT_EQ(moved.modelPath(), fixturePath("identity.onnx"));
}

TEST(OnnxSessionTest, MoveAssignment) {
  oa::OnnxSession a(fixturePath("identity.onnx"),
                {.provider = oa::ExecutionProvider::CPU});
  oa::OnnxSession b(fixturePath("add.onnx"),
                {.provider = oa::ExecutionProvider::CPU});

  b = std::move(a);
  EXPECT_TRUE(b.isValid());
  EXPECT_EQ(b.modelPath(), fixturePath("identity.onnx"));
}

// ---------------------------------------------------------------------------
// Introspection - Identity model (1 input, 1 output, float [1,4])
// ---------------------------------------------------------------------------

class IdentitySessionTest : public ::testing::Test {
 protected:
  void SetUp() override {
    session_ = std::make_unique<oa::OnnxSession>(fixturePath("identity.onnx"),
                                              oa::SessionConfig{
                                                  .provider = oa::ExecutionProvider::CPU,
                                                  .enableXnnpack = false});
  }
  std::unique_ptr<oa::OnnxSession> session_;
};

TEST_F(IdentitySessionTest, GetInputInfo) {
  auto inputs = session_->getInputInfo();
  ASSERT_EQ(inputs.size(), 1);
  EXPECT_EQ(inputs[0].name, "X");
  EXPECT_EQ(inputs[0].type, oa::TensorType::FLOAT32);
  ASSERT_EQ(inputs[0].shape.size(), 2);
  EXPECT_EQ(inputs[0].shape[0], 1);
  EXPECT_EQ(inputs[0].shape[1], 4);
}

TEST_F(IdentitySessionTest, GetOutputInfo) {
  auto outputs = session_->getOutputInfo();
  ASSERT_EQ(outputs.size(), 1);
  EXPECT_EQ(outputs[0].name, "Y");
  EXPECT_EQ(outputs[0].type, oa::TensorType::FLOAT32);
  ASSERT_EQ(outputs[0].shape.size(), 2);
  EXPECT_EQ(outputs[0].shape[0], 1);
  EXPECT_EQ(outputs[0].shape[1], 4);
}

TEST_F(IdentitySessionTest, RunSingleInput) {
  float data[] = {1.0f, 2.0f, 3.0f, 4.0f};
  oa::InputTensor input{.name = "X",
                    .shape = {1, 4},
                    .type = oa::TensorType::FLOAT32,
                    .data = data,
                    .dataSize = sizeof(data)};

  auto results = session_->run(input);
  ASSERT_EQ(results.size(), 1);
  EXPECT_EQ(results[0].name, "Y");
  EXPECT_EQ(results[0].type, oa::TensorType::FLOAT32);
  ASSERT_EQ(results[0].shape, (std::vector<int64_t>{1, 4}));
  ASSERT_EQ(results[0].elementCount(), 4);

  const float* out = results[0].as<float>();
  EXPECT_FLOAT_EQ(out[0], 1.0f);
  EXPECT_FLOAT_EQ(out[1], 2.0f);
  EXPECT_FLOAT_EQ(out[2], 3.0f);
  EXPECT_FLOAT_EQ(out[3], 4.0f);
}

TEST_F(IdentitySessionTest, RunMultipleInputsOverload) {
  float data[] = {5.0f, 6.0f, 7.0f, 8.0f};
  std::vector<oa::InputTensor> inputs = {
      {.name = "X",
       .shape = {1, 4},
       .type = oa::TensorType::FLOAT32,
       .data = data,
       .dataSize = sizeof(data)}};

  auto results = session_->run(inputs);
  ASSERT_EQ(results.size(), 1);

  const float* out = results[0].as<float>();
  EXPECT_FLOAT_EQ(out[0], 5.0f);
  EXPECT_FLOAT_EQ(out[3], 8.0f);
}

TEST_F(IdentitySessionTest, RunWithSpecificOutputNames) {
  float data[] = {10.0f, 20.0f, 30.0f, 40.0f};
  std::vector<oa::InputTensor> inputs = {
      {.name = "X",
       .shape = {1, 4},
       .type = oa::TensorType::FLOAT32,
       .data = data,
       .dataSize = sizeof(data)}};

  auto results = session_->run(inputs, {"Y"});
  ASSERT_EQ(results.size(), 1);
  EXPECT_EQ(results[0].name, "Y");

  const float* out = results[0].as<float>();
  EXPECT_FLOAT_EQ(out[0], 10.0f);
}

TEST_F(IdentitySessionTest, RunMultipleTimes) {
  for (int i = 0; i < 5; ++i) {
    float data[] = {static_cast<float>(i), 0.0f, 0.0f, 0.0f};
    oa::InputTensor input{.name = "X",
                      .shape = {1, 4},
                      .type = oa::TensorType::FLOAT32,
                      .data = data,
                      .dataSize = sizeof(data)};

    auto results = session_->run(input);
    EXPECT_FLOAT_EQ(results[0].as<float>()[0], static_cast<float>(i));
  }
}

// ---------------------------------------------------------------------------
// Add model (2 inputs, 1 output, float [1,4])
// ---------------------------------------------------------------------------

class AddSessionTest : public ::testing::Test {
 protected:
  void SetUp() override {
    session_ = std::make_unique<oa::OnnxSession>(
        fixturePath("add.onnx"),
        oa::SessionConfig{.provider = oa::ExecutionProvider::CPU,
                      .enableXnnpack = false});
  }
  std::unique_ptr<oa::OnnxSession> session_;
};

TEST_F(AddSessionTest, GetInputInfo) {
  auto inputs = session_->getInputInfo();
  ASSERT_EQ(inputs.size(), 2);
  EXPECT_EQ(inputs[0].name, "A");
  EXPECT_EQ(inputs[1].name, "B");
}

TEST_F(AddSessionTest, RunAddsInputs) {
  float a[] = {1.0f, 2.0f, 3.0f, 4.0f};
  float b[] = {10.0f, 20.0f, 30.0f, 40.0f};

  std::vector<oa::InputTensor> inputs = {
      {.name = "A",
       .shape = {1, 4},
       .type = oa::TensorType::FLOAT32,
       .data = a,
       .dataSize = sizeof(a)},
      {.name = "B",
       .shape = {1, 4},
       .type = oa::TensorType::FLOAT32,
       .data = b,
       .dataSize = sizeof(b)}};

  auto results = session_->run(inputs);
  ASSERT_EQ(results.size(), 1);
  EXPECT_EQ(results[0].name, "C");

  const float* out = results[0].as<float>();
  EXPECT_FLOAT_EQ(out[0], 11.0f);
  EXPECT_FLOAT_EQ(out[1], 22.0f);
  EXPECT_FLOAT_EQ(out[2], 33.0f);
  EXPECT_FLOAT_EQ(out[3], 44.0f);
}

// ---------------------------------------------------------------------------
// Multi-output model (1 input, 2 outputs: identity_out + relu_out)
// ---------------------------------------------------------------------------

class MultiOutputSessionTest : public ::testing::Test {
 protected:
  void SetUp() override {
    session_ = std::make_unique<oa::OnnxSession>(
        fixturePath("multi_output.onnx"),
        oa::SessionConfig{.provider = oa::ExecutionProvider::CPU,
                      .enableXnnpack = false});
  }
  std::unique_ptr<oa::OnnxSession> session_;
};

TEST_F(MultiOutputSessionTest, GetOutputInfo) {
  auto outputs = session_->getOutputInfo();
  ASSERT_EQ(outputs.size(), 2);
  EXPECT_EQ(outputs[0].name, "identity_out");
  EXPECT_EQ(outputs[1].name, "relu_out");
}

TEST_F(MultiOutputSessionTest, RunAllOutputs) {
  float data[] = {-2.0f, -1.0f, 0.0f, 3.0f};
  oa::InputTensor input{.name = "X",
                    .shape = {1, 4},
                    .type = oa::TensorType::FLOAT32,
                    .data = data,
                    .dataSize = sizeof(data)};

  auto results = session_->run(input);
  ASSERT_EQ(results.size(), 2);

  // Identity output: same as input
  const float* identity = results[0].as<float>();
  EXPECT_FLOAT_EQ(identity[0], -2.0f);
  EXPECT_FLOAT_EQ(identity[1], -1.0f);
  EXPECT_FLOAT_EQ(identity[2], 0.0f);
  EXPECT_FLOAT_EQ(identity[3], 3.0f);

  // Relu output: max(0, x)
  const float* relu = results[1].as<float>();
  EXPECT_FLOAT_EQ(relu[0], 0.0f);
  EXPECT_FLOAT_EQ(relu[1], 0.0f);
  EXPECT_FLOAT_EQ(relu[2], 0.0f);
  EXPECT_FLOAT_EQ(relu[3], 3.0f);
}

TEST_F(MultiOutputSessionTest, RunSelectiveOutput) {
  float data[] = {-1.0f, 0.0f, 1.0f, 2.0f};
  std::vector<oa::InputTensor> inputs = {
      {.name = "X",
       .shape = {1, 4},
       .type = oa::TensorType::FLOAT32,
       .data = data,
       .dataSize = sizeof(data)}};

  // Request only relu_out
  auto results = session_->run(inputs, {"relu_out"});
  ASSERT_EQ(results.size(), 1);
  EXPECT_EQ(results[0].name, "relu_out");

  const float* relu = results[0].as<float>();
  EXPECT_FLOAT_EQ(relu[0], 0.0f);
  EXPECT_FLOAT_EQ(relu[3], 2.0f);
}

// ---------------------------------------------------------------------------
// Int64 Identity model
// ---------------------------------------------------------------------------

TEST(OnnxSessionInt64Test, RunInt64Identity) {
  oa::OnnxSession session(fixturePath("identity_int64.onnx"),
                      {.provider = oa::ExecutionProvider::CPU,
                       .enableXnnpack = false});

  auto inputs_info = session.getInputInfo();
  ASSERT_EQ(inputs_info.size(), 1);
  EXPECT_EQ(inputs_info[0].type, oa::TensorType::INT64);

  int64_t data[] = {100, 200, 300};
  oa::InputTensor input{.name = "X",
                    .shape = {1, 3},
                    .type = oa::TensorType::INT64,
                    .data = data,
                    .dataSize = sizeof(data)};

  auto results = session.run(input);
  ASSERT_EQ(results.size(), 1);
  EXPECT_EQ(results[0].type, oa::TensorType::INT64);

  const int64_t* out = results[0].as<int64_t>();
  EXPECT_EQ(out[0], 100);
  EXPECT_EQ(out[1], 200);
  EXPECT_EQ(out[2], 300);
}

// ---------------------------------------------------------------------------
// Shared singleton env: multiple sessions use the same OnnxRuntime
// ---------------------------------------------------------------------------

TEST(OnnxSessionSharedEnvTest, MultipleSessionsShareEnv) {
  oa::OnnxSession session1(fixturePath("identity.onnx"),
                        {.provider = oa::ExecutionProvider::CPU,
                         .enableXnnpack = false});
  oa::OnnxSession session2(fixturePath("add.onnx"),
                        {.provider = oa::ExecutionProvider::CPU,
                         .enableXnnpack = false});
  oa::OnnxSession session3(fixturePath("multi_output.onnx"),
                        {.provider = oa::ExecutionProvider::CPU,
                         .enableXnnpack = false});

  EXPECT_TRUE(session1.isValid());
  EXPECT_TRUE(session2.isValid());
  EXPECT_TRUE(session3.isValid());

  // Run each to verify they all work independently
  float data[] = {1.0f, 2.0f, 3.0f, 4.0f};
  oa::InputTensor input{.name = "X",
                    .shape = {1, 4},
                    .type = oa::TensorType::FLOAT32,
                    .data = data,
                    .dataSize = sizeof(data)};

  auto r1 = session1.run(input);
  EXPECT_EQ(r1[0].as<float>()[0], 1.0f);

  auto r3 = session3.run(input);
  EXPECT_EQ(r3.size(), 2);
}

// ---------------------------------------------------------------------------
// Virtual dispatch through oa::IOnnxSession interface
// ---------------------------------------------------------------------------

TEST(OnnxSessionInterfaceTest, UseViaBasePointer) {
  auto session = std::make_unique<oa::OnnxSession>(
      fixturePath("identity.onnx"),
      oa::SessionConfig{.provider = oa::ExecutionProvider::CPU,
                    .enableXnnpack = false});

  oa::IOnnxSession* iface = session.get();

  EXPECT_TRUE(iface->isValid());
  EXPECT_EQ(iface->modelPath(), fixturePath("identity.onnx"));

  auto info = iface->getInputInfo();
  ASSERT_EQ(info.size(), 1);
  EXPECT_EQ(info[0].name, "X");

  float data[] = {42.0f, 0.0f, 0.0f, 0.0f};
  oa::InputTensor input{.name = "X",
                    .shape = {1, 4},
                    .type = oa::TensorType::FLOAT32,
                    .data = data,
                    .dataSize = sizeof(data)};

  auto results = iface->run(input);
  EXPECT_FLOAT_EQ(results[0].as<float>()[0], 42.0f);
}
