#pragma once

// Polymorphic VLA model interface for multi-architecture dispatch.
//
// `IVlaModel` hides the SmolVLA-specific C-style types and entry points from
// the addon layer so the same `VlaModel` shell can dispatch to either the
// existing SmolVLA implementation or the upcoming π₀.₅ implementation, keyed
// off the GGUF `general.architecture` metadata string (see
// `model_factory.hpp`).
//
// The generic hparams and timing structs intentionally use architecture-
// neutral field names. The SmolVLA adapter back-fills `prefill_*` from
// `smollm2_*`; the addon's runtimeStats() also re-emits the legacy SmolVLA-
// named keys until consumers migrate (TODO: drop after π₀.₅ ships).

#include <cstdint>
#include <string>

namespace qvac_lib_infer_vla_ggml {

// Architecture-neutral hyperparameters surfaced to the JS layer. Mirrors the
// subset of `smolvla_hparams` that `getVlaHparams` exposes, plus two new
// fields that capture the SmolVLA vs π₀.₅ delta (see plan §3).
struct VlaHparamsGeneric {
  int chunk_size = 0;
  int action_dim = 0;
  int max_action_dim = 0;
  int max_state_dim = 0;
  int tokenizer_max_length = 0;
  int vision_image_size = 0;
  // Number of camera views the model accepts. 2 for SmolVLA, up to 3 for
  // π₀.₅ (base_0_rgb, left_wrist_0_rgb, right_wrist_0_rgb).
  int num_cameras = 0;
  // How the consumer passes the robot state. SmolVLA takes a continuous
  // float vector projected by `state_proj`; π₀.₅ tokenizes the state into
  // digit tokens inlined into the language prompt — the `state` Float32Array
  // is ignored on the discrete path.
  enum class StateInputMode { Continuous, Discrete };
  StateInputMode state_input_mode = StateInputMode::Continuous;
};

// Architecture-neutral wall-clock timings (milliseconds). The SmolVLA-named
// `smollm2_compute_ms`/`smollm2_total_ms` keys live one level up (in the
// addon's runtimeStats()) for back-compat with existing JS tests.
struct VlaTimingGeneric {
  double vision_ms = 0.0;
  double prefill_compute_ms = 0.0; // was smollm2_compute_ms in SmolVLA
  double prefill_total_ms = 0.0;   // was smollm2_total_ms
  double ode_ms = 0.0;
  double total_ms = 0.0;
};

// Common interface every backend model implementation must conform to.
// `infer()` mirrors `smolvla_inference_with_timing` exactly so existing
// callers (AddonCpp.hpp's `runInternal`) can stay shape-for-shape identical.
// Pointer-to-pointer for `images` matches the existing pipeline; the
// addon wraps a `std::vector<std::vector<float>>` into an array of raw
// pointers before calling in.
class IVlaModel {
public:
  virtual ~IVlaModel() = default;

  virtual const VlaHparamsGeneric& hparams() const = 0;
  virtual std::string backendName() const = 0;
  virtual bool hasGpu() const = 0;

  // Run a single inference. Returns true on success. On failure, the
  // implementation should leave `actions_out`/`n_actions_out`/`timing_out`
  // unspecified — the caller treats the return value as authoritative.
  virtual bool infer(
      const float** images, int nImages, int imgWidth, int imgHeight,
      const float* state, int stateDim, const int32_t* langTokens,
      const bool* langMask, int langLen, const float* noise, float* actionsOut,
      int* nActionsOut, VlaTimingGeneric* timingOut) = 0;
};

} // namespace qvac_lib_infer_vla_ggml
