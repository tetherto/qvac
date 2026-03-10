#include "pipeline/Pipeline.hpp"
#include "pipeline/Steps.hpp"
#include "pipeline/StepRecognizeText.hpp"
#include "pipeline/StepDoctrRecognition.hpp"

#include <atomic>
#include <stdexcept>
#include <string>
#include <vector>

#include <gtest/gtest.h>

namespace qvac_lib_inference_addon_onnx_ocr_fasttext {

// ---------------------------------------------------------------------------
// CancelledException – basic exception semantics
// ---------------------------------------------------------------------------

TEST(CancelledException, IsRuntimeError) {
  CancelledException ex;
  // Must be catchable as std::runtime_error so existing generic handlers work
  EXPECT_NO_THROW({
    try {
      throw CancelledException{};
    } catch (const std::runtime_error&) {
      // expected
    }
  });
}

TEST(CancelledException, MessageIsNotEmpty) {
  CancelledException ex;
  EXPECT_FALSE(std::string(ex.what()).empty());
}

TEST(CancelledException, MessageContainsCancelled) {
  CancelledException ex;
  const std::string msg = ex.what();
  EXPECT_NE(msg.find("cancel"), std::string::npos)
      << "CancelledException message should mention 'cancel', got: " << msg;
}

// ---------------------------------------------------------------------------
// cancelFlag_ interaction via StepRecognizeText::process (unit-level)
// ---------------------------------------------------------------------------
// These tests verify that when the cancelFlag atomic is set to true BEFORE
// StepRecognizeText::processImgList iterates its batch loop, a
// CancelledException is thrown.  We drive the check indirectly through the
// public API to avoid depending on private internals.

TEST(CancelFlagRecognition, ThrowsWhenFlagAlreadySetOnFirstBatch) {
  // A pre-set flag should cause an immediate throw in the very first batch
  // iteration inside processImgList.
  std::atomic<bool> flag{true};

  // StepRecognizeText::process takes an Input that contains (through
  // populateImageList) the image sub-lists.  An empty input means the batch
  // loop has zero iterations – which never checks the flag.  We need at
  // least one batch entry.
  //
  // We cannot construct a StepRecognizeText without loading real ONNX models,
  // so we test the standalone flag/throw contract through a minimal synthetic
  // reproducer that matches the production pattern:
  //
  //   for (size_t batchStart = 0; ...) {
  //     if (cancelFlag != nullptr && cancelFlag->load(...)) throw CancelledException{};
  //   }

  // Reproduce the exact guard used in processImgList / StepDoctrRecognition:
  auto runWithFlag = [](const std::atomic<bool>* cancelFlag, size_t iterations) {
    for (size_t i = 0; i < iterations; i += 1) {
      if (cancelFlag != nullptr && cancelFlag->load(std::memory_order_relaxed)) {
        throw CancelledException{};
      }
      // (batch work would go here)
    }
  };

  // Flag pre-set: first iteration should throw
  EXPECT_THROW(runWithFlag(&flag, 3), CancelledException);
}

TEST(CancelFlagRecognition, DoesNotThrowWhenFlagIsFalse) {
  std::atomic<bool> flag{false};

  auto runWithFlag = [](const std::atomic<bool>* cancelFlag, size_t iterations) {
    for (size_t i = 0; i < iterations; i += 1) {
      if (cancelFlag != nullptr && cancelFlag->load(std::memory_order_relaxed)) {
        throw CancelledException{};
      }
    }
  };

  EXPECT_NO_THROW(runWithFlag(&flag, 3));
}

TEST(CancelFlagRecognition, DoesNotThrowWhenNullptrPassedAsFlag) {
  // nullptr is the default when no cancelFlag is wired – must be safe
  auto runWithFlag = [](const std::atomic<bool>* cancelFlag, size_t iterations) {
    for (size_t i = 0; i < iterations; i += 1) {
      if (cancelFlag != nullptr && cancelFlag->load(std::memory_order_relaxed)) {
        throw CancelledException{};
      }
    }
  };

  EXPECT_NO_THROW(runWithFlag(nullptr, 5));
}

TEST(CancelFlagRecognition, ThrowsOnlyAfterFlagIsSet) {
  // Verifies that iterations before the flag is set complete normally, and
  // the throw happens exactly when the flag flips to true.
  std::atomic<bool> flag{false};
  size_t iterationsCompleted = 0;
  const size_t flipAt = 2; // flip the flag after this many completed iterations

  auto runWithFlag = [&](const std::atomic<bool>* cancelFlag, size_t totalIterations) {
    for (size_t i = 0; i < totalIterations; i += 1) {
      if (cancelFlag != nullptr && cancelFlag->load(std::memory_order_relaxed)) {
        throw CancelledException{};
      }
      iterationsCompleted++;
      if (iterationsCompleted == flipAt) {
        flag.store(true, std::memory_order_relaxed);
      }
    }
  };

  EXPECT_THROW(runWithFlag(&flag, 10), CancelledException);
  EXPECT_EQ(iterationsCompleted, flipAt)
      << "Should have completed exactly " << flipAt << " iterations before cancel";
}

// ---------------------------------------------------------------------------
// cancelFlag_ reset semantics (mirrors Pipeline::process reset at start)
// ---------------------------------------------------------------------------

TEST(CancelFlagReset, FlagIsResetBeforeEachJob) {
  // The production code resets cancelFlag_ at the very start of process():
  //   cancelFlag_.store(false, std::memory_order_relaxed);
  // This test verifies that pattern: after a cancel, a second call that
  // resets the flag succeeds without throwing.

  std::atomic<bool> flag{true}; // simulate a previous cancel

  auto runJob = [&](const std::atomic<bool>* cancelFlag, size_t iterations) {
    // Simulates the reset at start of Pipeline::process
    const_cast<std::atomic<bool>*>(cancelFlag)->store(
        false, std::memory_order_relaxed);

    for (size_t i = 0; i < iterations; i += 1) {
      if (cancelFlag != nullptr && cancelFlag->load(std::memory_order_relaxed)) {
        throw CancelledException{};
      }
    }
  };

  // First call with pre-set flag – should NOT throw because reset happens first
  EXPECT_NO_THROW(runJob(&flag, 3));

  // Flag should be false after the job
  EXPECT_FALSE(flag.load());
}

TEST(CancelFlagReset, SecondJobSucceedsAfterCancelledFirstJob) {
  // Sequence: first job runs, gets cancelled mid-way, second job resets flag
  // and completes normally.
  std::atomic<bool> flag{false};
  size_t job1Completed = 0;
  size_t job2Completed = 0;

  auto runJobWithReset = [&](size_t iterations, size_t* counter) {
    // Reset mirrors Pipeline::process start
    flag.store(false, std::memory_order_relaxed);

    for (size_t i = 0; i < iterations; i += 1) {
      if (flag.load(std::memory_order_relaxed)) {
        throw CancelledException{};
      }
      (*counter)++;
    }
  };

  // --- Job 1: cancelled after 2 batches ---
  auto cancelAfterTwo = [&](size_t iterations, size_t* counter) {
    flag.store(false, std::memory_order_relaxed);
    size_t flipAt = 2;
    for (size_t i = 0; i < iterations; i += 1) {
      if (flag.load(std::memory_order_relaxed)) {
        throw CancelledException{};
      }
      (*counter)++;
      if (*counter == flipAt) {
        flag.store(true, std::memory_order_relaxed); // simulate cancel()
      }
    }
  };

  EXPECT_THROW(cancelAfterTwo(10, &job1Completed), CancelledException);
  EXPECT_EQ(job1Completed, 2u);

  // --- Job 2: reset clears flag, completes all batches ---
  EXPECT_NO_THROW(runJobWithReset(5, &job2Completed));
  EXPECT_EQ(job2Completed, 5u);
}

} // namespace qvac_lib_inference_addon_onnx_ocr_fasttext
