#include <common/common.h>
#include <gtest/gtest.h>

/// llama.cpp wires "continuous batching" through two independent knobs:
///   - `common_params.cont_batching` (bool flag): tells the runtime to
///     schedule new sequences for decoding on-the-fly.
///   - `common_params.n_parallel` (int): the number of concurrent slots
///     the engine should allocate. `common_context_params_to_llama` maps
///     it directly: `cparams.n_seq_max = params.n_parallel`. The
///     `llama_context` ctor then clamps `n_seq_max = std::max(1u, ...)`,
///     so `n_parallel = 1` always yields a single-slot context.
///
/// Our `LlamaModel::init()` only constructs the `ContinuousBatchScheduler`
/// when `llama_n_seq_max(ctx) > 1`. With the upstream defaults
/// (`cont_batching = true`, `n_parallel = 1`), the scheduler stays
/// inert: the flag is on but there is exactly one slot, so multi-
/// sequence batching cannot be exercised. Multi-sequence batching
/// requires the caller to explicitly raise `n_parallel`.
///
/// llama-server follows the same mapping: `--parallel N` sets
/// `params.n_parallel = N`, which becomes `n_seq_max = N`. There is no
/// separate server-side "max sequences" knob. See upstream issue
/// #16432 for why `n_seq_max` is misnamed (it is not a max, it is the
/// exact slot allocation copied from `n_parallel`).
TEST(ContinuousBatchingDefault, CommonParamsDefaultsLeaveSchedulerInert) {
  common_params params;
  EXPECT_TRUE(params.cont_batching)
      << "common_params.cont_batching should default to true "
         "(llama.cpp continuous batching flag enabled by default)";
  EXPECT_EQ(params.n_parallel, 1)
      << "common_params.n_parallel should default to 1; this becomes "
         "cparams.n_seq_max = 1, which keeps our scheduler inert (gated "
         "on n_seq_max > 1)";
}
