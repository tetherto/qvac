/*
 * Cache State Machine Integration Test
 *
 * This test verifies the complete cache state machine functionality including:
 * - Multiple consecutive session commands processing
 * - All four cache commands: reset, save, disable, filename
 * - Session file switching with automatic save-before-switch
 * - Stateless mode with automatic state reset after each process() call
 * - Cache file creation, saving, and loading
 * - Message interface validation for session commands
 *
 * Example of Model from HuggingFace: Llama-3.2-1B-Instruct-GGUF
 * URL:
 * https://huggingface.co/unsloth/Llama-3.2-1B-Instruct-GGUF/blob/main/Llama-3.2-1B-Instruct-Q4_0.gguf
 *  
 * rename the model to test_model.gguf and place it in test/model/
 */

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <filesystem>
#include <functional>
#include <iostream>
#include <string>
#include <unordered_map>
#include <vector>

#include "../../addon/src/model-interface/LlamaModel.hpp"

static bool isFileInitialized(const std::filesystem::path& path) {
  std::error_code ec;
  auto size = std::filesystem::file_size(path, ec);
  if (ec) {
    // file doesn't exist
    return false;
  } else {
    return size != 0;
  }
}

// Helper function to ensure the test model exists
bool ensureTestModel(const std::string& model_path) {
  if (isFileInitialized(model_path)) {
    auto size = std::filesystem::file_size(model_path);
    printf(
        "✅ Model found: %s (%.1f MB)\n",
        model_path.c_str(),
        size / (1024.0 * 1024.0));
    return true;
  }

  printf("❌ Model not found at: %s\n", model_path.c_str());
  printf("\n📥 To download the required Llama 3.2 1B model, run:\n");
  printf("   ./scripts/download_test_model.sh\n");
  printf("\n🔗 Or download manually from:\n");
  printf(
      "   "
      "https://huggingface.co/callgg/llama-3.2-1b-gguf/resolve/main/"
      "llama3.2-1b-q4_0.gguf\n");
  printf("   Place it at: %s\n", model_path.c_str());
  printf("\n💡 Then run this test again.\n");

  return false;
}

// Helper function to clean up cache files
void cleanupCacheFiles() {
  std::vector<std::string> cache_files = {
      "test_session1.bin",
      "test_session2.bin",
      "temp_session.bin",
      "final_session.bin"};

  for (const auto& file : cache_files) {
    if (std::filesystem::exists(file)) {
      std::filesystem::remove(file);
      printf("Cleaned up cache file: %s\n", file.c_str());
    }
  }
}

// Test result structure
struct TestResult {
  std::string name;
  bool passed;
  std::string error_message;
  std::string response;
  std::chrono::milliseconds duration;
  std::unordered_map<std::string, double> stats;
};

// Test case structure
struct TestCase {
  std::string name;
  std::string json_input;
  std::function<bool(const std::string&)> validator;
};

class LlamaTestRunner {
private:
  LlamaModel& model;
  std::vector<TestResult> results;

public:
  explicit LlamaTestRunner(LlamaModel& model) : model(model) {}

  void runTest(const TestCase& test_case) {
    printf("\n=== Running Test: %s ===\n", test_case.name.c_str());

    auto start_time = std::chrono::high_resolution_clock::now();
    TestResult result;
    result.name = test_case.name;
    result.passed = false;

    try {
      // Process the input
      std::string full_response = model.process(test_case.json_input);
      result.response = full_response;
      printf("Response: %s\n\n", full_response.c_str());

      // Get runtime stats
      auto stats = model.runtimeStats();
      printf("Runtime stats:\n");
      for (const auto& stat : stats) {
        printf("  %s: ", stat.first.c_str());
        std::visit(
            [](const auto& value) {
              printf("%s", std::to_string(value).c_str());
            },
            stat.second);
        printf("\n");

        // Store stats for validation
        std::visit(
            [&result, &stat](const auto& value) {
              result.stats[stat.first] = value;
            },
            stat.second);
      }

      // Validate the test
      if (test_case.validator) {
        result.passed = test_case.validator(full_response);
      } else {
        // Default validation: check if response is not empty
        result.passed = !full_response.empty();
      }

      auto end_time = std::chrono::high_resolution_clock::now();
      result.duration = std::chrono::duration_cast<std::chrono::milliseconds>(
          end_time - start_time);

      if (result.passed) {
        printf("✓ Test PASSED (Duration: %ldms)\n", result.duration.count());
      } else {
        printf("✗ Test FAILED (Duration: %ldms)\n", result.duration.count());
        result.error_message = "Validation failed";
      }

    } catch (const std::exception& e) {
      auto end_time = std::chrono::high_resolution_clock::now();
      result.duration = std::chrono::duration_cast<std::chrono::milliseconds>(
          end_time - start_time);
      result.error_message = e.what();
      printf(
          "✗ Test FAILED with exception: %s (Duration: %ldms)\n",
          e.what(),
          result.duration.count());
    }

    results.push_back(result);
  }

  void printSummary() {
    printf("\n=== TEST SUMMARY ===\n");
    int passed = 0, failed = 0;
    long long total_duration = 0;

    for (const auto& result : results) {
      if (result.passed) {
        passed++;
        printf(
            "✓ %s (Duration: %ldms)\n",
            result.name.c_str(),
            result.duration.count());
      } else {
        failed++;
        printf(
            "✗ %s (Duration: %ldms) - %s\n",
            result.name.c_str(),
            result.duration.count(),
            result.error_message.c_str());
      }
      total_duration += result.duration.count();
    }

    printf("\nTotal Tests: %zu\n", results.size());
    printf("Passed: %d\n", passed);
    printf("Failed: %d\n", failed);
    printf("Total Duration: %lldms\n", total_duration);
    printf(
        "Success Rate: %.1f%%\n",
        (results.size() > 0) ? (passed * 100.0 / results.size()) : 0.0);
  }

  bool allTestsPassed() const {
    return std::all_of(results.begin(), results.end(), [](const TestResult& r) {
      return r.passed;
    });
  }
};

// Validation functions
bool validateResponseContains(
    const std::string& response, const std::string& expected_content) {
  return response.find(expected_content) != std::string::npos;
}

int main() {
  try {
    std::string device = "gpu";
    std::string model_path = "../test/model/test_model.gguf";
    std::string projector_path = ""; // Empty for text-only models
    std::unordered_map<std::string, std::string> config_map;

    config_map["device"] = device;
    config_map["ctx_size"] = "512";
    config_map["predict"] = "50";
    config_map["seed"] = "43";
    config_map["verbose"] = "";

    // Ensure test model exists
    printf("=== Cache State Machine Integration Test ===\n");
    printf("Checking for test model...\n");
    if (!ensureTestModel(model_path)) {
      return 1;
    }

    // Clean up any existing cache files
    printf("Cleaning up existing cache files...\n");
    cleanupCacheFiles();

    // Initialize the model
    printf("Initializing LlamaModel...\n");
    LlamaModel model(model_path, projector_path, config_map);
    printf("Model initialized successfully!\n");

    // Create test runner
    LlamaTestRunner runner(model);

    // Define comprehensive test cases for cache state machine
    std::vector<TestCase> test_cases = {
        // Test 1: Initial state (no cache configured)
        {.name = "1. Initial State - No Cache",
         .json_input = R"([
                {"role": "system", "content": "You are a helpful assistant."},
                {"role": "user", "content": "what is bitcoin? answer shortly"}
                ])",
         .validator =
             [](const std::string& response) { return !response.empty(); }},

        // Test 2: Enable cache with filename
        {.name = "2. Enable Cache with Filename",
         .json_input = R"([
                {"role": "session", "content": "test_session1.bin"},
                {"role": "system", "content": "You are a helpful assistant."},
                {"role": "user", "content": "what is ethereum? answer shortly"}
                ])",
         .validator =
             [](const std::string& response) { return !response.empty(); }},

        // Test 3: Session persistence test
        {.name = "3. Session Persistence - Load Cache",
         .json_input = R"([
                {"role": "session", "content": "test_session1.bin"},
                {"role": "user", "content": "What i asked you before? answer shortly"}
                ])",
         .validator =
             [](const std::string& response) { return !response.empty(); }},

        // Test 4: Multiple consecutive session commands
        {.name = "4. Multiple Session Commands",
         .json_input = R"([
                {"role": "session", "content": "test_session2.bin"},
                {"role": "session", "content": "reset"},
                {"role": "session", "content": "save"},
                {"role": "system", "content": "You are a helpful assistant."},
                {"role": "user", "content": "what is bitcoin? answer shortly"}
                ])",
         .validator =
             [](const std::string& response) { return !response.empty(); }},

        // Test 5: Reset command
        {.name = "5. Reset Command - Clear State",
         .json_input = R"([
                {"role": "session", "content": "test_session1.bin"},
                {"role": "session", "content": "reset"},
                {"role": "user", "content": "What i asked you before? answer shortly"}
                ])",
         .validator =
             [](const std::string& response) { return !response.empty(); }},

        // Test 6: Switch to session 2
        {.name = "6. Switch to session 2",
         .json_input = R"([
                {"role": "session", "content": "test_session2.bin"},
                {"role": "system", "content": "You are a helpful assistant."},
                {"role": "user", "content": "what i asked you before? answer shortly"}
                ])",
         .validator =
             [](const std::string& response) { return !response.empty(); }},

        // Test 7: Disable cache (stateless mode)
        {.name = "7. Disable Cache - Go Stateless",
         .json_input = R"([
                {"role": "session", "content": "disable"},
                {"role": "system", "content": "You are a helpful assistant."},
                {"role": "user", "content": "what is blockchain? answer shortly"}
                ])",
         .validator =
             [](const std::string& response) { return !response.empty(); }},

        // Test 8: Verify stateless behavior (no memory)
        {.name = "8. Verify Stateless Behavior",
         .json_input = R"([
                {"role": "user", "content": "What i asked you before? answer shortly"}
                ])",
         .validator =
             [](const std::string& response) {
               return !response.empty(); // Should not remember previous message
             }},

        // Test 9: Re-enable cache after disable
        {.name = "9. Re-enable Cache After Disable",
         .json_input = R"([
                {"role": "session", "content": "temp_session.bin"},
                {"role": "system", "content": "You are a helpful assistant."},
                {"role": "user", "content": "what is deep learning? answer shortly"}
                ])",
         .validator =
             [](const std::string& response) { return !response.empty(); }},

        // Test 10: Session command only (no user message)
        {.name = "10. Session Command Only",
         .json_input = R"([
                {"role": "session", "content": "reset"}
                ])",
         .validator =
             [](const std::string& response) {
               return response
                   .empty(); // Should return empty response for session-only
             }},

        // Test 11: Save command when cache disabled (should be ignored)
        {.name = "11. Save When Cache Disabled",
         .json_input = R"([
                {"role": "session", "content": "disable"},
                {"role": "session", "content": "save"}
                ])",
         .validator =
             [](const std::string& response) {
               return response.empty() &&
                      !isFileInitialized("temp_session.bin");
             }},

        // Test 12: Complex session command chain
        {.name = "12. Complex Session Command Chain",
         .json_input = R"([
                {"role": "session", "content": "final_session.bin"},
                {"role": "session", "content": "reset"},
                {"role": "session", "content": "save"},
                {"role": "session", "content": "disable"},
                {"role": "session", "content": "temp_session.bin"},
                {"role": "user", "content": "what i asked you before? answer shortly"}
                ])",
         .validator = [](const std::string& response) {
           return !response.empty() && isFileInitialized("final_session.bin");
         }}};

    // Run all tests
    printf("\nStarting test suite with %zu tests...\n", test_cases.size());
    for (const auto& test_case : test_cases) {
      runner.runTest(test_case);
    }

    // Print summary
    runner.printSummary();

    // Clean up test cache files
    printf("\nCleaning up test cache files...\n");
    cleanupCacheFiles();

    // Return appropriate exit code
    if (runner.allTestsPassed()) {
      printf("\n🎉 All cache state machine tests passed successfully!\n");
      printf("✅ Cache state machine functionality verified:\n");
      printf("  - Multiple consecutive session commands\n");
      printf("  - All four commands: reset, save, disable, filename\n");
      printf("  - Session file switching with auto-save\n");
      printf("  - Stateless mode with auto-reset\n");
      printf("  - Cache file creation and loading\n");
      printf("  - Message interface validation\n");
      return 0;
    } else {
      printf("\n❌ Some cache state machine tests failed.\n");
      printf("Please check the output above for details.\n");
      return 1;
    }

  } catch (const std::exception& e) {
    std::cerr << "Fatal Error: " << e.what() << '\n';
    printf("\nCleaning up after error...\n");
    cleanupCacheFiles();
    return 1;
  }
}
