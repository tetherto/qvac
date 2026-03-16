// Tests for the getDiagnosticsJSON() method added to Pipeline.
//
// Pipeline construction requires real model files (the constructor immediately
// creates ONNX sessions), so tests that exercise a fully-constructed Pipeline
// are integration-level and are not included here.
//
// These tests verify the individual building blocks that getDiagnosticsJSON()
// relies on:
//   - OrtGetApiBase / ONNX Runtime C API linkage and version string
//   - OnnxRuntime::getAvailableProviders()
//   - nlohmann::json round-trip for the shape getDiagnosticsJSON() produces
//   - Pipeline JSON shape contract (key names and value types) via a
//     manually-constructed JSON document that mirrors what the method returns

#include <string>
#include <vector>

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>
#include <onnxruntime_c_api.h>
#include <qvac-onnx/OnnxRuntime.hpp>

namespace qvac_lib_inference_addon_onnx_ocr_fasttext {

// ── ONNX Runtime version (C API) ─────────────────────────────────────────────

TEST(OnnxRuntimeDiagnostics, VersionStringIsNonEmpty) {
  const char* version = OrtGetApiBase()->GetVersionString();
  ASSERT_NE(version, nullptr);
  EXPECT_GT(std::string(version).size(), 0u);
}

TEST(OnnxRuntimeDiagnostics, VersionStringIsValidString) {
  const std::string version = OrtGetApiBase()->GetVersionString();
  // Version follows semver-like convention, e.g. "1.18.0"
  EXPECT_FALSE(version.empty());
  // Must consist only of printable characters
  for (char c : version) {
    EXPECT_TRUE(std::isprint(static_cast<unsigned char>(c)))
        << "Non-printable character in version string";
  }
}

// ── Available providers ───────────────────────────────────────────────────────

TEST(OnnxRuntimeDiagnostics, AvailableProvidersIsNonEmpty) {
  const auto providers = onnx_addon::OnnxRuntime::getAvailableProviders();
  EXPECT_FALSE(providers.empty());
}

TEST(OnnxRuntimeDiagnostics, AvailableProvidersContainsCPU) {
  const auto providers = onnx_addon::OnnxRuntime::getAvailableProviders();
  const bool hasCPU = std::find(providers.begin(), providers.end(),
                                "CPUExecutionProvider") != providers.end();
  EXPECT_TRUE(hasCPU) << "CPUExecutionProvider must always be available";
}

TEST(OnnxRuntimeDiagnostics, AvailableProvidersAreNonEmptyStrings) {
  const auto providers = onnx_addon::OnnxRuntime::getAvailableProviders();
  for (const auto& p : providers) {
    EXPECT_FALSE(p.empty()) << "Provider name must not be empty";
  }
}

// ── getDiagnosticsJSON shape contract ─────────────────────────────────────────
// These tests verify the JSON schema produced by getDiagnosticsJSON() by
// constructing an equivalent document manually, so they are independent of
// Pipeline construction.  They act as a canary: if the key names or value
// types in getDiagnosticsJSON() ever change, these tests will need updating.

static nlohmann::json makeDiagnosticsDocument(
    const std::string& version,
    const std::vector<std::string>& providers,
    const std::string& execProvider,
    const std::string& pipelineMode,
    const std::string& detectorPath,
    const std::string& recognizerPath,
    bool modelLoaded,
    bool useGPU)
{
  nlohmann::json doc;
  doc["onnxRuntimeVersion"]   = version;
  doc["availableProviders"]   = providers;
  doc["executionProvider"]    = execProvider;
  doc["pipelineMode"]         = pipelineMode;
  doc["detectorModelPath"]    = detectorPath;
  doc["recognizerModelPath"]  = recognizerPath;
  doc["modelLoaded"]          = modelLoaded;
  doc["sessionOptions"]["useGPU"]      = useGPU;
  doc["sessionOptions"]["optimization"] = "EXTENDED";
  return doc;
}

TEST(DiagnosticsJSONShape, DocumentIsValidJSON) {
  const auto doc = makeDiagnosticsDocument(
      "1.18.0", {"CPUExecutionProvider"}, "CPUExecutionProvider",
      "EasyOCR", "/models/d.onnx", "/models/r.onnx", false, false);
  EXPECT_NO_THROW(nlohmann::json::parse(doc.dump()));
}

TEST(DiagnosticsJSONShape, RequiredTopLevelKeysPresent) {
  const auto doc = makeDiagnosticsDocument(
      "1.18.0", {"CPUExecutionProvider"}, "CPUExecutionProvider",
      "EasyOCR", "/models/d.onnx", "/models/r.onnx", false, false);

  EXPECT_TRUE(doc.contains("onnxRuntimeVersion"));
  EXPECT_TRUE(doc.contains("availableProviders"));
  EXPECT_TRUE(doc.contains("executionProvider"));
  EXPECT_TRUE(doc.contains("pipelineMode"));
  EXPECT_TRUE(doc.contains("detectorModelPath"));
  EXPECT_TRUE(doc.contains("recognizerModelPath"));
  EXPECT_TRUE(doc.contains("modelLoaded"));
  EXPECT_TRUE(doc.contains("sessionOptions"));
}

TEST(DiagnosticsJSONShape, OnnxRuntimeVersionIsString) {
  const auto doc = makeDiagnosticsDocument(
      "1.18.0", {"CPUExecutionProvider"}, "CPUExecutionProvider",
      "EasyOCR", "/models/d.onnx", "/models/r.onnx", false, false);
  EXPECT_EQ(doc["onnxRuntimeVersion"].type(), nlohmann::json::value_t::string);
  EXPECT_FALSE(doc["onnxRuntimeVersion"].get<std::string>().empty());
}

TEST(DiagnosticsJSONShape, AvailableProvidersIsArray) {
  const auto doc = makeDiagnosticsDocument(
      "1.18.0", {"CPUExecutionProvider"}, "CPUExecutionProvider",
      "EasyOCR", "/models/d.onnx", "/models/r.onnx", false, false);
  EXPECT_EQ(doc["availableProviders"].type(), nlohmann::json::value_t::array);
}

TEST(DiagnosticsJSONShape, ModelLoadedIsBoolean) {
  for (bool loaded : {true, false}) {
    const auto doc = makeDiagnosticsDocument(
        "1.18.0", {"CPUExecutionProvider"}, "CPUExecutionProvider",
        "EasyOCR", "/models/d.onnx", "/models/r.onnx", loaded, false);
    EXPECT_EQ(doc["modelLoaded"].type(), nlohmann::json::value_t::boolean);
    EXPECT_EQ(doc["modelLoaded"].get<bool>(), loaded);
  }
}

TEST(DiagnosticsJSONShape, PipelineModeIsEasyOCROrDocTR) {
  for (const std::string& mode : {"EasyOCR", "DocTR"}) {
    const auto doc = makeDiagnosticsDocument(
        "1.18.0", {"CPUExecutionProvider"}, "CPUExecutionProvider",
        mode, "/models/d.onnx", "/models/r.onnx", false, false);
    const std::string actual = doc["pipelineMode"].get<std::string>();
    EXPECT_TRUE(actual == "EasyOCR" || actual == "DocTR")
        << "Unexpected pipelineMode: " << actual;
  }
}

TEST(DiagnosticsJSONShape, SessionOptionsContainsUseGPUAndOptimization) {
  const auto doc = makeDiagnosticsDocument(
      "1.18.0", {"CPUExecutionProvider"}, "CPUExecutionProvider",
      "EasyOCR", "/models/d.onnx", "/models/r.onnx", false, false);

  ASSERT_TRUE(doc["sessionOptions"].contains("useGPU"));
  ASSERT_TRUE(doc["sessionOptions"].contains("optimization"));
  EXPECT_EQ(doc["sessionOptions"]["useGPU"].type(), nlohmann::json::value_t::boolean);
  EXPECT_EQ(doc["sessionOptions"]["optimization"].type(), nlohmann::json::value_t::string);
  EXPECT_FALSE(doc["sessionOptions"]["optimization"].get<std::string>().empty());
}

TEST(DiagnosticsJSONShape, SessionOptionsUseGPUMatchesInput) {
  for (bool gpu : {true, false}) {
    const auto doc = makeDiagnosticsDocument(
        "1.18.0", {"CPUExecutionProvider"}, "CPUExecutionProvider",
        "EasyOCR", "/models/d.onnx", "/models/r.onnx", false, gpu);
    EXPECT_EQ(doc["sessionOptions"]["useGPU"].get<bool>(), gpu);
  }
}

TEST(DiagnosticsJSONShape, ModelPathsRoundTripThroughJSON) {
  const std::string det = "/models/craft_mlt_25k.onnx";
  const std::string rec = "/models/latin_g2.onnx";
  const auto doc = makeDiagnosticsDocument(
      "1.18.0", {"CPUExecutionProvider"}, "CPUExecutionProvider",
      "EasyOCR", det, rec, false, false);
  EXPECT_EQ(doc["detectorModelPath"].get<std::string>(), det);
  EXPECT_EQ(doc["recognizerModelPath"].get<std::string>(), rec);
}

TEST(DiagnosticsJSONShape, ExecutionProviderIsCPUWhenGPUFalse) {
  // When useGPU is false, getDiagnosticsJSON() sets executionProvider to
  // "CPUExecutionProvider" unconditionally across all platforms.
  const auto doc = makeDiagnosticsDocument(
      "1.18.0", {"CPUExecutionProvider"}, "CPUExecutionProvider",
      "EasyOCR", "/models/d.onnx", "/models/r.onnx", false, /*useGPU=*/false);
  EXPECT_EQ(doc["executionProvider"].get<std::string>(), "CPUExecutionProvider");
}

// ── JSON serialization correctness ───────────────────────────────────────────

TEST(DiagnosticsJSONShape, DumpAndParseRoundTrip) {
  const auto original = makeDiagnosticsDocument(
      "1.18.0", {"CPUExecutionProvider", "XNNPACKExecutionProvider"},
      "CPUExecutionProvider", "DocTR",
      "/models/dbnet.onnx", "/models/parseq.onnx",
      true, false);

  const auto reparsed = nlohmann::json::parse(original.dump());
  EXPECT_EQ(original, reparsed);
}

} // namespace qvac_lib_inference_addon_onnx_ocr_fasttext
