#pragma once

namespace qvac_lib_inference_addon_llama {

/// Ceiling for `parallel` — the scheduler's thread-pool size, and the model
/// context's `n_seq_max`. This is the engine's own bound: `llama_context`
/// rejects `n_seq_max > LLAMA_MAX_SEQ`, and `llama_init_from_model` swallows
/// that error (it logs the reason and returns nullptr), so a larger value could
/// only spawn its whole eager thread pool and then fail the load with a
/// generic message. Validating against it up front keeps the failure
/// actionable and cheap.
///
/// LLAMA_MAX_SEQ is defined in qvac-fabric's internal `src/llama-cparams.h`,
/// which is not among the installed public headers (only `llama.h` and
/// `llama-cpp.h`), so it cannot be included and is mirrored here.
/// `test/unit/test_parallel_ceiling.cpp` pins this value and `MAX_PARALLEL` in
/// `index.js` mirrors it for the JS-side validation — a fabric bump that
/// changes LLAMA_MAX_SEQ must update all three plus the docs.
inline constexpr unsigned K_MAX_PARALLEL_WORKERS = 256;

} // namespace qvac_lib_inference_addon_llama
