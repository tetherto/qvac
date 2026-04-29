#include "GenerationParamsApply.hpp"

#include <exception>
#include <string>
#include <utility>

#include <nlohmann/json.hpp>
#include <qvac-lib-inference-addon-cpp/Errors.hpp>

#include "addon/LlmErrors.hpp"
#include "common/json-schema-to-grammar.h"
#include "common/log.h"

void applyGenerationOverridesToSampling(
    common_params_sampling& sampling, int& nPredict,
    const GenerationParams& overrides) {
  auto setIf = [](const auto& src, auto& dst) {
    if (src) {
      dst = *src;
    }
  };

  setIf(overrides.temp, sampling.temp);
  setIf(overrides.top_p, sampling.top_p);
  setIf(overrides.top_k, sampling.top_k);
  setIf(overrides.n_predict, nPredict);
  setIf(overrides.seed, sampling.seed);
  setIf(overrides.frequency_penalty, sampling.penalty_freq);
  setIf(overrides.presence_penalty, sampling.penalty_present);
  setIf(overrides.repeat_penalty, sampling.penalty_repeat);

  // `json_schema` and `grammar` are mutually exclusive at the JS boundary
  // and in `AddonJs::runJob::parseText`, so reaching this branch with both
  // set means a caller bypassed those checks (most likely the C++ unit
  // tests or `cli_tool` driving the helper directly). Log a warning so
  // the issue surfaces in stderr/log output and pick `json_schema`, which
  // is the higher-level surface.
  if (overrides.json_schema && overrides.grammar) {
    LOG_WRN(
        "%s: both generationParams.grammar and generationParams.json_schema "
        "were provided; ignoring `grammar` and applying `json_schema` "
        "(the JS and AddonJs paths reject this combination — this branch "
        "exists only for direct C++ callers).\n",
        __func__);
  }

  if (overrides.json_schema) {
    try {
      auto parsed = nlohmann::ordered_json::parse(*overrides.json_schema);
      sampling.grammar = json_schema_to_grammar(parsed);
    } catch (const std::exception& ex) {
      throw qvac_errors::StatusError(
          ADDON_ID,
          qvac_errors::general_error::toString(
              qvac_errors::general_error::InvalidArgument),
          std::string("invalid generationParams.json_schema: ") + ex.what());
    }
  } else if (overrides.grammar) {
    sampling.grammar = *overrides.grammar;
  }
}

std::function<void()> applyGenerationParamsToContext(
    common_params& params, CommonSamplerPtr& smpl, llama_model* model,
    const GenerationParams& overrides) {
  if (!overrides.hasOverrides()) {
    return []() {};
  }

  // Apply overrides to *local copies* first. Only commit them onto the
  // live `params` and `smpl` after both the json_schema parse/convert and
  // `common_sampler_init` have succeeded — otherwise a partially applied
  // override (e.g. temp/seed already written, then json_schema throws)
  // would leak into subsequent requests because no restore lambda gets
  // returned to the caller's `ScopeGuard`.
  common_params_sampling nextSampling = params.sampling;
  int nextPredict = params.n_predict;

  // May throw `InvalidArgument` for malformed `json_schema`. `params`
  // and `smpl` remain untouched in that case.
  applyGenerationOverridesToSampling(nextSampling, nextPredict, overrides);

  // `common_sampler_init` returns nullptr on bad inputs (most commonly an
  // invalid GBNF grammar — `json_schema` is converted to GBNF above and
  // can in principle produce a grammar that the sampler rejects). Build
  // the new sampler before touching live state so a failure here also
  // leaves `params` / `smpl` intact.
  CommonSamplerPtr nextSmpl(common_sampler_init(model, nextSampling));
  if (!nextSmpl) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        qvac_errors::general_error::toString(
            qvac_errors::general_error::InvalidArgument),
        "failed to initialise sampler with per-request generationParams "
        "(invalid grammar or json_schema?)");
  }

  // Snapshot the live values before committing so the restore lambda can
  // roll the request's mutations back at the end of the call.
  common_params_sampling savedSampling = params.sampling;
  int savedPredict = params.n_predict;

  params.sampling = std::move(nextSampling);
  params.n_predict = nextPredict;
  smpl = std::move(nextSmpl);

  bool restored = false;
  return [&params,
          &smpl,
          model,
          savedSampling = std::move(savedSampling),
          savedPredict,
          restored]() mutable {
    if (restored)
      return;
    restored = true;
    params.sampling = savedSampling;
    params.n_predict = savedPredict;
    smpl.reset(common_sampler_init(model, params.sampling));
  };
}
