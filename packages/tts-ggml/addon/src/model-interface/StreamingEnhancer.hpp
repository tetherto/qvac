#pragma once

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <numeric>
#include <vector>

namespace qvac::ttsggml {

/**
 * Stateful streaming wrapper around the one-shot LavaSR enhancer so the
 * Chatterbox native chunk-streaming path can emit enhanced (bandwidth-extended)
 * audio chunk-by-chunk instead of only on the batch path.
 *
 * WHY this is non-trivial: `tts_cpp::lavasr::Enhancer::enhance()` is a
 * whole-signal operation. Its ConvNeXt backbone is convolutional over mel
 * frames (a bounded temporal receptive field), but the final FastLR crossover
 * does a single FFT over the *entire* input. Running it independently per chunk
 * would (a) change the result versus batch and (b) leave audible seams at chunk
 * boundaries (ISTFT overlap-add edges + FFT circular-convolution edges).
 *
 * APPROACH — overlap-reprocess with look-ahead margin + crossfade:
 *   - Buffer the raw engine PCM. For each step, re-run the one-shot enhancer on
 *     a window = [left context] + [new audio] + [look-ahead margin].
 *   - Only emit the interior of that window: the left context and the
 *     look-ahead margin absorb the enhancer's receptive field and the FFT/ISTFT
 *     edge effects, so the emitted region matches the batch result (exactly for
 *     a shift-invariant transform whose support fits inside the margins; very
 *     closely for the real enhancer, where the global FastLR FFT differs
 *     slightly with window length).
 *   - A short linear crossfade across consecutive windows' shared region hides
 *     any residual mismatch, so the concatenated stream has no per-chunk seams.
 *
 * Because the look-ahead margin must cover the enhancer's receptive field
 * (~0.34 s at 24 kHz for the current LavaSR enhancer), enhanced streaming adds
 * that much algorithmic latency — unavoidable: the network genuinely needs the
 * future audio to synthesise the high band at a given instant. The final chunk
 * (flush) drains the held margin.
 *
 * The enhancer (resample to 48 kHz + ConvNeXt + ISTFT + FastLR, optionally
 * resampled to a caller-requested output rate) is injected as `EnhanceFn`, so
 * this class carries no tts-cpp/ggml dependency and is unit-testable in
 * isolation by injecting a known transform.
 *
 * Stateful, single-utterance: feed() each engine chunk, flush() once at the
 * end. Resident memory is O(context + margin + chunk), NOT O(total duration):
 * the consumed input prefix is dropped after every feed().
 *
 * Mirrors the WsolaTimeStretch feed()/flush()/apply() shape so the two
 * post-processing stages compose cleanly in ChatterboxModel::synthesize().
 */
class StreamingEnhancer {
public:
  // Maps a contiguous raw input block (at inRate) to enhanced output (at
  // outRate). Must behave like a shift-invariant transform with bounded
  // temporal support for the streamed output to track the batch result; the
  // LavaSR enhancer satisfies this up to the global FastLR FFT, whose residual
  // the crossfade smooths.
  using EnhanceFn =
      std::function<std::vector<float>(const std::vector<float>&)>;

  /**
   * @param fn        the one-shot enhance transform (inRate -> outRate)
   * @param inRate    raw input sample rate (engine native, e.g. 24000)
   * @param outRate   enhanced output sample rate (e.g. 48000, or a caller rate)
   * @param contextIn left-context samples (inRate) prepended for warm-up
   * @param marginIn  look-ahead samples (inRate) held back so emitted frames
   *                  have right-context; also the added algorithmic latency
   * @param crossfadeIn crossfade length (inRate) across window seams
   *
   * Defaults are sized for the LavaSR enhancer at 24 kHz input: ~0.34 s of
   * context/margin (its ConvNeXt receptive field of ~31 mel frames at hop 512,
   * 48 kHz, plus the STFT/ISTFT window) and a ~11 ms crossfade.
   */
  explicit StreamingEnhancer(
      EnhanceFn fn, int inRate, int outRate, int contextIn = 8192,
      int marginIn = 8192, int crossfadeIn = 256)
      : fn_(std::move(fn)),
        ratio_(static_cast<double>(outRate) / static_cast<double>(inRate)),
        // Reduced denominator of outRate/inRate. Window/commit boundaries are
        // snapped to multiples of Q so that `winStart * ratio` is always an
        // integer — i.e. every window's enhanced output lands on one global
        // output-sample grid. That makes the crossfade between consecutive
        // windows align sample-for-sample even when the ratio is non-integral
        // (Q == 1 for the integer 24k->48k case, so this is a no-op there).
        alignQ_(std::max(1, inRate / std::gcd(inRate, outRate))),
        contextIn_(std::max(0, contextIn)), marginIn_(std::max(0, marginIn)),
        crossfadeIn_(std::max(0, crossfadeIn)) {}

  /**
   * Append raw input samples and return whatever finalized enhanced output is
   * ready (at outRate). May be empty for the first call(s) until enough
   * look-ahead has accumulated; call flush() at the end to drain the rest.
   */
  std::vector<float> feed(const float* in, std::size_t n) {
    inBuf_.insert(inBuf_.end(), in, in + n);
    inTotal_ += static_cast<int64_t>(n);
    return process(/*final=*/false);
  }

  /** Drain the tail. No more feed() calls are valid after this. */
  std::vector<float> flush() { return process(/*final=*/true); }

  /** One-shot convenience (batch parity): feed-all + flush. */
  static std::vector<float> apply(
      const EnhanceFn& fn, const std::vector<float>& in, int inRate,
      int outRate) {
    StreamingEnhancer s(fn, inRate, outRate);
    std::vector<float> out = s.feed(in.data(), in.size());
    const std::vector<float> tail = s.flush();
    out.insert(out.end(), tail.begin(), tail.end());
    return out;
  }

  /** Test-only: live resident input samples (bounded-memory assertion). */
  std::size_t residentSamples() const { return inBuf_.size(); }

private:
  // Largest multiple of alignQ_ that is <= x (x >= 0). Snapping boundaries to
  // the grid keeps the per-window output aligned (see alignQ_).
  int64_t alignDown(int64_t x) const {
    if (x <= 0)
      return 0;
    return x - (x % alignQ_);
  }

  // Output index (into the current window's enhanced output of length `len`)
  // for absolute input index `i`, given the window started at `winStart`.
  // Exact (no rounding) when both `i` and `winStart` are multiples of alignQ_.
  long outIndex(int64_t i, int64_t winStart, std::size_t len) const {
    long v = std::lround(static_cast<double>(i - winStart) * ratio_);
    return std::clamp(v, 0L, static_cast<long>(len));
  }

  std::vector<float> process(bool finalPass) {
    const int64_t availEnd = inTotal_;
    // How far we can finalize: keep `marginIn_` of look-ahead on non-final
    // passes so emitted frames see their right-context. The final pass drains
    // everything (and need not be grid-snapped — there is no further window to
    // align with). Non-final commits snap to the alignment grid.
    int64_t commitEnd = finalPass ? availEnd : alignDown(availEnd - marginIn_);
    if (!finalPass && commitEnd <= heldEndIn_) {
      return {}; // no new committable input beyond what's already held
    }
    if (commitEnd < sentIn_)
      commitEnd = sentIn_;

    // Recompute from `contextIn_` before the last sent position so the
    // re-emitted region (incl. the held crossfade span) has full left-context.
    // Snap to the grid so `winStart * ratio` is integral.
    int64_t winStart = alignDown(std::max<int64_t>(0, sentIn_ - contextIn_));
    winStart = std::max(winStart, inBase_);
    const std::size_t winOff = static_cast<std::size_t>(winStart - inBase_);
    std::vector<float> window(
        inBuf_.begin() + static_cast<std::ptrdiff_t>(winOff), inBuf_.end());
    if (window.empty())
      return {};

    std::vector<float> out = fn_(window);
    const std::size_t L = out.size();

    std::vector<float> result;

    // --- Crossfade span: re-emit input [sentIn_, heldEndIn_) blending the
    //     previous window's held output with this window's recomputation. ---
    const long oSent = outIndex(sentIn_, winStart, L);
    const long oHeldEnd = outIndex(heldEndIn_, winStart, L);
    const long span = std::max(0L, oHeldEnd - oSent);
    const std::size_t xl =
        std::min(held_.size(), static_cast<std::size_t>(span));
    for (std::size_t k = 0; k < xl; ++k) {
      const double w = static_cast<double>(k + 1) / static_cast<double>(xl + 1);
      result.push_back(
          static_cast<float>(
              (1.0 - w) * held_[k] +
              w * out[static_cast<std::size_t>(oSent) + k]));
    }
    // Cover any rounding drift between the two windows' lengths with the new
    // window's samples (keeps the emitted stream input-contiguous).
    for (long j = oSent + static_cast<long>(xl); j < oHeldEnd; ++j) {
      result.push_back(out[static_cast<std::size_t>(j)]);
    }

    // --- Region B: fresh contiguous output (heldEndIn_, newSentEnd). ---
    // Hold back `crossfadeIn_` of just-committed audio (grid-snapped) so the
    // next window can crossfade into it; the final pass keeps nothing back.
    int64_t newSentEnd =
        finalPass ? commitEnd
                  : std::max(heldEndIn_, alignDown(commitEnd - crossfadeIn_));
    const long oNewSent = outIndex(newSentEnd, winStart, L);
    for (long j = oHeldEnd; j < oNewSent; ++j) {
      result.push_back(out[static_cast<std::size_t>(j)]);
    }
    sentIn_ = newSentEnd;

    // --- Reserve the new held (crossfade) span [newSentEnd, commitEnd). ---
    if (!finalPass && commitEnd > newSentEnd) {
      const long a = outIndex(newSentEnd, winStart, L);
      const long b = outIndex(commitEnd, winStart, L);
      held_.assign(out.begin() + a, out.begin() + b);
      heldEndIn_ = commitEnd;
    } else {
      held_.clear();
      heldEndIn_ = sentIn_;
    }

    if (!finalPass)
      compactInput();
    return result;
  }

  // Drop input below the lowest absolute index the next window can read
  // (sentIn_ - contextIn_), keeping resident memory O(context + margin +
  // chunk). Grid-snapped so inBase_ stays a multiple of alignQ_ (the next
  // winStart).
  void compactInput() {
    const int64_t keepFrom =
        alignDown(std::max<int64_t>(0, sentIn_ - contextIn_));
    if (keepFrom > inBase_) {
      const std::size_t drop = static_cast<std::size_t>(keepFrom - inBase_);
      inBuf_.erase(
          inBuf_.begin(),
          inBuf_.begin() +
              static_cast<std::ptrdiff_t>(std::min(drop, inBuf_.size())));
      inBase_ = keepFrom;
    }
  }

  EnhanceFn fn_;
  const double ratio_;
  const int64_t alignQ_;
  const int contextIn_;
  const int marginIn_;
  const int crossfadeIn_;

  std::vector<float> inBuf_; // live raw input; inBuf_[0] == absolute inBase_
  int64_t inBase_ = 0;       // absolute input index of inBuf_[0]
  int64_t inTotal_ = 0;      // total raw samples fed (absolute end)
  int64_t sentIn_ = 0;       // input index up to which output has been sent
  int64_t heldEndIn_ = 0;    // input index up to which output is computed/held
  std::vector<float> held_;  // output samples for [sentIn_, heldEndIn_), held
                             // back to crossfade with the next window
};

} // namespace qvac::ttsggml
