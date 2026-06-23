#pragma once

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <limits>
#include <vector>

namespace qvac::ttsggml::chatterbox {

/**
 * Pitch-preserving time-scale modification (WSOLA — Waveform Similarity
 * Overlap-Add).
 *
 *   outputDuration = inputDuration / speed
 *
 * `speed < 1` slows speech down (longer output), `speed > 1` speeds it up
 * (shorter output); pitch is preserved, unlike a plain resample.  The
 * semantics mirror Supertonic's `speed` (a duration multiplier) so the two
 * engines expose the same knob.
 *
 * WHY this lives in the addon and not the engine: Chatterbox's
 * `tts_cpp::chatterbox::Engine` has no native speaking-rate control.  Its S3
 * speech tokens are emitted at a fixed 25 Hz and the utterance duration is
 * emergent from the autoregressive T3 decode, so there is no duration
 * predictor to scale (this is exactly what Supertonic has and Chatterbox
 * lacks).  We therefore apply rate control as a post-synthesis step on the
 * 24 kHz PCM.  It is functionally equivalent to ffmpeg's `atempo` filter
 * (WSOLA overlap-add), not a quality upgrade over it.
 *
 * Stateful so it works for both batch synthesis (feed-all + flush) and the
 * native streaming chunk loop (feed each chunk, flush on the last one): a
 * single instance carries the overlap-add tail and similarity-search target
 * across chunk boundaries, so streamed output has no per-chunk seams.
 */
class WsolaTimeStretch {
public:
  explicit WsolaTimeStretch(
      float speed, int frameSize = 1024, int synthesisHop = 512,
      int searchRadius = 256)
      : N_(frameSize), Hs_(synthesisHop),
        Ha_(std::max(
            1, static_cast<int>(
                   std::lround(synthesisHop * static_cast<double>(speed))))),
        search_(searchRadius), window_(makeHann(frameSize)) {
    target_.assign(static_cast<std::size_t>(N_), 0.0f);
  }

  /**
   * Append input samples and return whatever finalized output samples are
   * ready.  Output trails input by up to one frame; call flush() at the end
   * to drain the remainder.
   */
  std::vector<float> feed(const float* in, std::size_t n) {
    inBuf_.insert(inBuf_.end(), in, in + n);
    inLenReal_ += n;
    return process(/*final=*/false);
  }

  /** Drain the tail.  No more feed() calls are valid after this. */
  std::vector<float> flush() { return process(/*final=*/true); }

  /** One-shot convenience for the batch path. */
  static std::vector<float> apply(const std::vector<float>& in, float speed) {
    WsolaTimeStretch s(speed);
    std::vector<float> out = s.feed(in.data(), in.size());
    const std::vector<float> tail = s.flush();
    out.insert(out.end(), tail.begin(), tail.end());
    return out;
  }

private:
  static std::vector<float> makeHann(int n) {
    std::vector<float> w(static_cast<std::size_t>(n));
    if (n == 1) {
      w[0] = 1.0f;
      return w;
    }
    for (int i = 0; i < n; ++i) {
      w[static_cast<std::size_t>(i)] =
          0.5f * (1.0f - std::cos(2.0f * PI * i / (n - 1)));
    }
    return w;
  }

  // Overlap-add the windowed input frame starting at `inPos` into the
  // accumulator at the current synthesis position `outPos_`.  `norm_` tracks
  // the overlapped window sum so finalize() can divide it back out (Hann at
  // 50% overlap is constant-overlap-add in steady state; normalizing also
  // corrects the ramped first/last frames).
  void olaAddFrame(std::size_t inPos) {
    const std::size_t need = outPos_ + static_cast<std::size_t>(N_);
    if (acc_.size() < need) {
      acc_.resize(need, 0.0f);
      norm_.resize(need, 0.0f);
    }
    for (int k = 0; k < N_; ++k) {
      const float w = window_[static_cast<std::size_t>(k)];
      acc_[outPos_ + static_cast<std::size_t>(k)] +=
          inBuf_[inPos + static_cast<std::size_t>(k)] * w;
      norm_[outPos_ + static_cast<std::size_t>(k)] += w;
    }
  }

  // Find the frame start near `ideal` whose overlap region best matches the
  // running `target_` (the natural waveform continuation predicted from the
  // previously emitted frame).  Plain cross-correlation, classic WSOLA.
  std::size_t bestMatch(long ideal, std::size_t inLimit) const {
    const long lo = std::max<long>(0, ideal - search_);
    const long hiCap = static_cast<long>(inLimit) - N_;
    const long hi = std::min<long>(ideal + search_, hiCap);
    if (hi <= lo)
      return static_cast<std::size_t>(
          std::max<long>(0, std::min(ideal, hiCap)));
    long best = lo;
    float bestScore = -std::numeric_limits<float>::infinity();
    for (long a = lo; a <= hi; ++a) {
      float score = 0.0f;
      for (int k = 0; k < N_; ++k) {
        score +=
            inBuf_[static_cast<std::size_t>(a) + static_cast<std::size_t>(k)] *
            target_[static_cast<std::size_t>(k)];
      }
      if (score > bestScore) {
        bestScore = score;
        best = a;
      }
    }
    return static_cast<std::size_t>(best);
  }

  void setTarget(std::size_t a) {
    // Natural continuation = the N samples that would follow this frame at
    // the synthesis hop, i.e. in[a+Hs .. a+Hs+N].  Zero-pad past the end.
    const std::size_t start = a + static_cast<std::size_t>(Hs_);
    for (int k = 0; k < N_; ++k) {
      const std::size_t idx = start + static_cast<std::size_t>(k);
      target_[static_cast<std::size_t>(k)] =
          idx < inBuf_.size() ? inBuf_[idx] : 0.0f;
    }
  }

  std::vector<float> process(bool finalPass) {
    // In the final pass, zero-pad the input so frame/search reads near the
    // end stay in bounds; we stop the loop by `inLenReal_`, so the padding
    // only ever contributes a negligible windowed tail.
    if (finalPass) {
      const std::size_t guard =
          inLenReal_ + static_cast<std::size_t>(N_ + search_ + Ha_) + 1;
      if (inBuf_.size() < guard)
        inBuf_.resize(guard, 0.0f);
    }

    while (true) {
      if (firstFrame_) {
        if (inBuf_.size() < static_cast<std::size_t>(N_))
          break; // need a full frame
        olaAddFrame(0);
        setTarget(0);
        anaIdeal_ = Ha_;
        outPos_ += static_cast<std::size_t>(Hs_);
        firstFrame_ = false;
        continue;
      }

      if (!finalPass) {
        const std::size_t needHi =
            static_cast<std::size_t>(anaIdeal_ + search_ + N_);
        if (inBuf_.size() < needHi)
          break; // wait for more input
      } else if (anaIdeal_ >= static_cast<long>(inLenReal_)) {
        break; // consumed all real input
      }

      const std::size_t a = bestMatch(anaIdeal_, inBuf_.size());
      olaAddFrame(a);
      setTarget(a);
      anaIdeal_ += Ha_;
      outPos_ += static_cast<std::size_t>(Hs_);
    }

    return finalize(finalPass);
  }

  // Emit the finalized prefix.  A sample at index j is final once no future
  // frame can write to it — future frames start at `outPos_`, so everything
  // below outPos_ is done.  On the final pass, emit the whole remaining tail.
  std::vector<float> finalize(bool finalPass) {
    const std::size_t end = finalPass ? acc_.size() : outPos_;
    std::vector<float> out;
    if (end <= emitted_)
      return out;
    out.reserve(end - emitted_);
    for (std::size_t j = emitted_; j < end; ++j) {
      const float n = norm_[j];
      out.push_back(n > 1e-6f ? acc_[j] / n : acc_[j]);
    }
    emitted_ = end;
    return out;
  }

  static constexpr float PI = 3.14159265358979323846f;

  const int N_;
  const int Hs_;
  const int Ha_;
  const long search_;
  const std::vector<float> window_;

  std::vector<float> inBuf_;
  std::size_t inLenReal_ = 0; // real fed length (excludes final-pass padding)
  std::vector<float> target_;

  std::vector<float> acc_;
  std::vector<float> norm_;
  std::size_t outPos_ = 0;
  std::size_t emitted_ = 0;
  long anaIdeal_ = 0;
  bool firstFrame_ = true;
};

} // namespace qvac::ttsggml::chatterbox
