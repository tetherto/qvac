#pragma once

#include <functional>

#include "LlmContext.hpp"
#include "common/common.h"

// Apply per-request `generationParams` overrides onto a sampling block
// + `n_predict` value in place. Operates on the two mutable fields the
// helper actually needs so callers can pass *copies* and only commit
// them to live state once the whole call (including json_schema parse
// and `common_sampler_init`) has succeeded — avoiding partial mutation
// of the live `common_params` if this throws.
//
// If `overrides.json_schema` is set, parses the JSON Schema and converts
// it to GBNF via llama.cpp's `json_schema_to_grammar()`, mirroring what
// the `--json-schema` load-time flag does. If `overrides.grammar` is set,
// the GBNF is used verbatim. The two are mutually exclusive (validated at
// the JS boundary and again in `AddonJs::runJob::parseText`); if both are
// present here a `LOG_WRN` is emitted and `json_schema` wins — the JS and
// AddonJs paths reject this combination, so reaching it means a direct
// C++ caller (unit tests / `cli_tool`) bypassed those checks.
//
// Throws `qvac_errors::StatusError(InvalidArgument)` when `json_schema`
// fails to parse or convert. Caller is responsible for re-initialising
// the sampler after this call so the new sampling block takes effect.
void applyGenerationOverridesToSampling(
    common_params_sampling& sampling, int& nPredict,
    const GenerationParams& overrides);

// Apply per-request `generationParams` overrides onto a context's live
// `params` + `smpl` and return a restore lambda the caller can install
// into a `ScopeGuard` to roll the mutation back at end-of-request.
//
// Implements the atomic-commit pattern: overrides are applied to local
// copies of `params.sampling` and `params.n_predict`, the new sampler is
// built against those copies, and only after both the json_schema parse
// and `common_sampler_init` have succeeded are the live `params` / `smpl`
// updated. Any throw or null-sampler failure leaves live state untouched.
//
// Returns a no-op lambda when `overrides.hasOverrides()` is false. The
// returned lambda re-initialises `smpl` from the saved sampling block, so
// it MUST be invoked before the owning context is destroyed (i.e. via a
// guard scoped to the request).
//
// Throws `qvac_errors::StatusError(InvalidArgument)` for malformed
// `json_schema` or when the resulting GBNF is rejected by the sampler.
//
// `params`, `smpl`, and `model` are captured by reference inside the
// returned lambda; callers must guarantee they outlive the lambda. Both
// `TextLlmContext::applyGenerationParams` and
// `MtmdLlmContext::applyGenerationParams` satisfy this — the context
// owns the fields and outlives any single request.
std::function<void()> applyGenerationParamsToContext(
    common_params& params, CommonSamplerPtr& smpl, llama_model* model,
    const GenerationParams& overrides);
