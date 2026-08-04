#pragma once

// GGUF-keyed VLA model factory.
//
// Sniffs the `general.architecture` string key (falling back to `model_type`
// for older converters, then defaulting to "smolvla" so the existing GGUFs
// that don't set the key continue to load) and returns the matching
// `IVlaModel` subclass. The sniff opens the GGUF a second time on the
// fast path — accepted ~10–100 ms cost; the real load reopens and mmaps
// from scratch so no state is shared.

#include <memory>
#include <string>

#include "model-interface/vla_model.hpp"

namespace qvac_lib_infer_vla_ggml {

// Read the `general.architecture` key from a GGUF file. Returns the lower-
// cased value, or `"smolvla"` if neither `general.architecture` nor
// `model_type` is present (legacy GGUFs converted before the key was
// introduced). Throws std::runtime_error if the file cannot be opened.
std::string sniffGgufArchitecture(const std::string& ggufPath);

// Build the matching `IVlaModel` instance. Recognised architectures:
//   "smolvla" → SmolvlaModelAdapter (the existing implementation)
//   "pi05"    → Pi05Model
//   "groot"   → GrootModel
// Any other value throws std::runtime_error with the offending arch name.
// `embodiment` selects a multi-embodiment GR00T GGUF's embodiment by tag or
// numeric cat_id, optionally overriding its camera count (unset = the GGUF's
// default); ignored by the other architectures.
std::unique_ptr<IVlaModel> createVlaModelFromGguf(
    const std::string& ggufPath, bool forceCpu, const std::string& backendsDir,
    const VlaEmbodimentRequest& embodiment = {});

} // namespace qvac_lib_infer_vla_ggml
