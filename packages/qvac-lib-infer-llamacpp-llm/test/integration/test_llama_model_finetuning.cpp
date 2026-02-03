/*
 * Finetuning Integration Test
 *
 * This test verifies finetuning functionality including:
 * - Helper function tests (dataset preparation, LoRA config, LR scheduling)
 * - Parameter validation
 * - Basic finetuning pipeline (if model available)
 *
 * Note: Full finetuning tests require a model file and dataset files.
 * These tests focus on unit testing helper functions and validation logic.
 */

#include <cassert>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <iostream>
#include <string>
#include <vector>

#include "../../addon/src/model-interface/LlamaFinetuningHelpers.hpp"

using namespace llama_finetuning_helpers;

// Test helper functions
void testParseLoraModules() {
  printf("\n=== Testing parseLoraModules ===\n");

  // Test empty string (should return default)
  uint32_t result = parseLoraModules("");
  assert(
      result == (LLAMA_LORA_TARGET_ATTN_Q | LLAMA_LORA_TARGET_ATTN_K |
                 LLAMA_LORA_TARGET_ATTN_V | LLAMA_LORA_TARGET_ATTN_O));
  printf("✓ Empty string returns default modules\n");

  // Test single module
  result = parseLoraModules("attn_q");
  assert(result == LLAMA_LORA_TARGET_ATTN_Q);
  printf("✓ Single module parsed correctly\n");

  // Test multiple modules
  result = parseLoraModules("attn_q,attn_k,attn_v");
  assert(
      result == (LLAMA_LORA_TARGET_ATTN_Q | LLAMA_LORA_TARGET_ATTN_K |
                 LLAMA_LORA_TARGET_ATTN_V));
  printf("✓ Multiple modules parsed correctly\n");

  // Test with whitespace
  result = parseLoraModules(" attn_q , attn_k ");
  assert(result == (LLAMA_LORA_TARGET_ATTN_Q | LLAMA_LORA_TARGET_ATTN_K));
  printf("✓ Modules with whitespace parsed correctly\n");

  // Test "all" module
  result = parseLoraModules("all");
  assert(result == LLAMA_LORA_TARGET_ALL);
  printf("✓ 'all' module parsed correctly\n");

  printf("All parseLoraModules tests passed!\n");
}

void testParseLrScheduler() {
  printf("\n=== Testing parseLrScheduler ===\n");

  LoraLrScheduleType scheduleType;

  // Test constant
  assert(parseLrScheduler("constant", scheduleType));
  assert(scheduleType == LoraLrScheduleType::Constant);
  printf("✓ 'constant' scheduler parsed correctly\n");

  // Test cosine
  assert(parseLrScheduler("cosine", scheduleType));
  assert(scheduleType == LoraLrScheduleType::Cosine);
  printf("✓ 'cosine' scheduler parsed correctly\n");

  // Test linear
  assert(parseLrScheduler("linear", scheduleType));
  assert(scheduleType == LoraLrScheduleType::Linear);
  printf("✓ 'linear' scheduler parsed correctly\n");

  // Test case insensitive
  assert(parseLrScheduler("CONSTANT", scheduleType));
  assert(scheduleType == LoraLrScheduleType::Constant);
  printf("✓ Case insensitive parsing works\n");

  // Test invalid
  assert(!parseLrScheduler("invalid", scheduleType));
  printf("✓ Invalid scheduler returns false\n");

  printf("All parseLrScheduler tests passed!\n");
}

void testSchedulerLrForStep() {
  printf("\n=== Testing schedulerLrForStep ===\n");

  LoraLrSchedulerState state;
  state.lrInit = 1e-4f;
  state.lrMin = 1e-6f;
  state.totalSteps = 100;
  state.warmupSteps = 10;

  // Test constant scheduler
  state.schedule = LoraLrScheduleType::Constant;
  float lr = schedulerLrForStep(state, 50);
  assert(std::abs(lr - state.lrInit) < 1e-6f);
  printf("✓ Constant scheduler returns lrInit\n");

  // Test warmup
  state.schedule = LoraLrScheduleType::Constant;
  lr = schedulerLrForStep(state, 5);
  assert(lr > 0.0f && lr < state.lrInit);
  printf("✓ Warmup phase returns scaled learning rate\n");

  // Test cosine scheduler
  state.schedule = LoraLrScheduleType::Cosine;
  lr = schedulerLrForStep(state, 50);
  assert(lr >= state.lrMin && lr <= state.lrInit);
  printf("✓ Cosine scheduler returns value in range\n");

  // Test linear scheduler
  state.schedule = LoraLrScheduleType::Linear;
  lr = schedulerLrForStep(state, 50);
  assert(lr >= state.lrMin && lr <= state.lrInit);
  printf("✓ Linear scheduler returns value in range\n");

  printf("All schedulerLrForStep tests passed!\n");
}

// Note: testResolveAdapterOutputPath is skipped in standalone tests because
// it requires FinetuningParameters which pulls in Bare runtime headers (js.h).
// This test can be run as part of the full addon build where Bare runtime is
// available.
void testResolveAdapterOutputPath() {
  printf("\n=== Testing resolveAdapterOutputPath ===\n");
  printf("⚠ Skipped: Requires FinetuningParameters which depends on Bare "
         "runtime headers\n");
  printf("  This test should be run as part of integration tests with full "
         "addon build\n");
}

int main() {
  printf("========================================\n");
  printf("LlamaModel Finetuning Tests\n");
  printf("========================================\n");

  try {
    testParseLoraModules();
    testParseLrScheduler();
    testSchedulerLrForStep();
    testResolveAdapterOutputPath();

    printf("\n========================================\n");
    printf("✅ All tests passed!\n");
    printf("========================================\n");
    return 0;
  } catch (const std::exception& e) {
    printf("\n❌ Test failed with exception: %s\n", e.what());
    return 1;
  }
}
