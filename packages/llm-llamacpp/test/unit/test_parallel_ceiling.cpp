#include <common/common.h>
#include <gtest/gtest.h>
#include <llama.h>

#include "utils/ParallelLimits.hpp"

using qvac_lib_inference_addon_llama::K_MAX_PARALLEL_WORKERS;

/// `parallel` is validated against K_MAX_PARALLEL_WORKERS in createInstance and
/// ends up as the context's `n_seq_max` (common_params.n_parallel ->
/// cparams.n_seq_max). llama_context throws when that exceeds LLAMA_MAX_SEQ,
/// and llama_init_from_model swallows the throw — it logs the reason and
/// returns nullptr — so a value above the engine's bound cannot surface a
/// useful error: it spawns the whole eager thread pool first and then fails
/// the load generically. The bound therefore has to be enforced up front.
///
/// LLAMA_MAX_SEQ lives in qvac-fabric's internal src/llama-cparams.h and is
/// NOT among the installed public headers (only llama.h and llama-cpp.h), so
/// this cannot be a static_assert against the engine's own constant. It pins
/// the mirrored value instead: a fabric bump that changes LLAMA_MAX_SEQ fails
/// here, which is the prompt to update this constant, the MAX_PARALLEL mirror
/// in index.js, and the docs together.
TEST(ParallelCeiling, MirrorsTheEngineSequenceLimit) {
  EXPECT_EQ(K_MAX_PARALLEL_WORKERS, 256U)
      << "K_MAX_PARALLEL_WORKERS must equal LLAMA_MAX_SEQ in the pinned "
         "qvac-fabric (src/llama-cparams.h). If fabric changed it, update "
         "this expectation, K_MAX_PARALLEL_WORKERS, MAX_PARALLEL in index.js, "
         "and docs/continuous-batching.md together.";
}

/// The ceiling is only meaningful if it is expressible as n_seq_max, which is
/// a uint32_t field — a guard against the mirror drifting to something the
/// engine could not represent.
TEST(ParallelCeiling, CeilingFitsInTheContextSequenceField) {
  llama_context_params cparams = llama_context_default_params();
  cparams.n_seq_max = K_MAX_PARALLEL_WORKERS;
  EXPECT_EQ(cparams.n_seq_max, K_MAX_PARALLEL_WORKERS);
  EXPECT_GE(K_MAX_PARALLEL_WORKERS, 1U);
}

/// The default stays single-slot, so the scheduler is inert unless the caller
/// opts in (paired with ContinuousBatchingDefault in
/// test_continuous_batching_default.cpp).
TEST(ParallelCeiling, DefaultParallelIsWithinTheCeiling) {
  common_params params;
  EXPECT_GE(params.n_parallel, 1);
  EXPECT_LE(static_cast<unsigned>(params.n_parallel), K_MAX_PARALLEL_WORKERS);
}
