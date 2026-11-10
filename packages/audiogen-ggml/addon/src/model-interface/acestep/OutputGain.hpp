#pragma once

#include <cmath>
#include <vector>

namespace qvac::audiogenggml::acestep {

// Peak the addon scales a normalized generation to before the int16
// quantisation, and the peak below which a result counts as silence.
// MIN_NORMALIZATION_PEAK ~= -60 dBFS.
constexpr float TARGET_OUTPUT_PEAK = 0.9F;
constexpr float MIN_NORMALIZATION_PEAK = 1e-3F;

// What the addon knows about a run when it decides the output gain.
struct OutputGainRequest {
  // `normalizeLoudness` on the job (default true).
  bool normalizeLoudness = true;
  // The run executed an edit plan (FlowEdit / Repaint).
  bool isEdit = false;
  // The run generated a lego stem.
  bool isLegoStem = false;
};

// The engine only normalizes loudness when the caller asked for it, and never
// for an edit (Repaint preserves untouched source regions bit-for-bit) or a
// lego stem (it keeps its mix gain relative to the source). The addon follows
// the same rule, so those three outputs reach the caller at the engine's gain.
inline bool normalizesOutput(const OutputGainRequest& request) {
  return request.normalizeLoudness && !request.isEdit && !request.isLegoStem;
}

// Gain applied to the engine's float PCM before the int16 quantisation.
//
// A normalized generation is scaled to a fixed TARGET_OUTPUT_PEAK
// (gain = 0.9 / peak): the engine's percentile normalization leaves the peak
// at full scale, and the headroom keeps the int16 conversion from clipping. A
// silent or near-silent result is left untouched, since dividing by a ~0 peak
// would turn low-level noise into a full-scale blast.
//
// Every other output keeps gain 1.0; samples the VAE left outside [-1, 1] then
// saturate at int16 full scale.
inline float
outputGain(const std::vector<float>& pcm, const OutputGainRequest& request) {
  if (!normalizesOutput(request))
    return 1.0F;
  float peak = 0.0F;
  for (const float sample : pcm)
    peak = std::fmax(peak, std::fabs(sample));
  return peak > MIN_NORMALIZATION_PEAK ? TARGET_OUTPUT_PEAK / peak : 1.0F;
}

} // namespace qvac::audiogenggml::acestep
