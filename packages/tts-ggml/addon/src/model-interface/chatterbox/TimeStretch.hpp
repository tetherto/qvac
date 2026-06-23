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
 *
 * Memory is bounded for streaming: consumed input and emitted output prefixes
 * are dropped after each `feed()` (the live buffers track an absolute base
 * index), so resident memory is O(chunk + window), NOT O(total duration).
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

  /** Test-only: live resident sample count (input + output accumulators). */
  std::size_t residentSamples() const {
    return inBuf_.size() + acc_.size() + norm_.size();
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
          0.5f * (1.0f - std::cos(2.0f * kPi * i / (n - 1)));
    }
    return w;
  }

  // Absolute index just past the last buffered input sample.  inBuf_[0] holds
  // absolute index inBase_, so absolute index `i` lives at inBuf_[i - inBase_].
  std::size_t inAvail() const { return inBase_ + inBuf_.size(); }

  // Overlap-add the windowed input frame starting at absolute `inPos` into the
  // accumulator at the current synthesis position `outPos_`.  `norm_` tracks
  // the overlapped window sum so finalize() can divide it back out (Hann at
  // 50% overlap is constant-overlap-add in steady state; normalizing also
  // corrects the ramped first/last frames).  acc_/norm_ are indexed relative
  // to outBase_ (the absolute index of acc_[0]).
  void olaAddFrame(std::size_t inPos) {
    const std::size_t need =
        (outPos_ + static_cast<std::size_t>(N_)) - outBase_;
    if (acc_.size() < need) {
      acc_.resize(need, 0.0f);
      norm_.resize(need, 0.0f);
    }
    const std::size_t accOff = outPos_ - outBase_;
    const std::size_t inOff = inPos - inBase_;
    for (int k = 0; k < N_; ++k) {
      const float w = window_[static_cast<std::size_t>(k)];
      acc_[accOff + static_cast<std::size_t>(k)] +=
          inBuf_[inOff + static_cast<std::size_t>(k)] * w;
      norm_[accOff + static_cast<std::size_t>(k)] += w;
    }
  }

  // Find the frame start near `ideal` whose overlap region best matches the
  // running `target_` (the natural waveform continuation predicted from the
  // previously emitted frame).  Plain cross-correlation, classic WSOLA.
  std::size_t bestMatch(long ideal, std::size_t inLimitAbs) const {
    const long lo = std::max<long>(static_cast<long>(inBase_), ideal - search_);
    const long hiCap = static_cast<long>(inLimitAbs) - N_;
    const long hi = std::min<long>(ideal + search_, hiCap);
    if (hi <= lo) {
      return static_cast<std::size_t>(
          std::max<long>(static_cast<long>(inBase_), std::min(ideal, hiCap)));
    }
    long best = lo;
    float bestScore = -std::numeric_limits<float>::infinity();
    for (long a = lo; a <= hi; ++a) {
      const std::size_t inOff = static_cast<std::size_t>(a) - inBase_;
      float dot = 0.0f;
      float energy = 0.0f;
      for (int k = 0; k < N_; ++k) {
        const float s = inBuf_[inOff + static_cast<std::size_t>(k)];
        dot += s * target_[static_cast<std::size_t>(k)];
        energy += s * s;
      }
      // Normalized cross-correlation: divide out the candidate frame's energy
      // so the match favors the most similar waveform SHAPE, not merely the
      // loudest offset. Raw correlation biases toward high-energy frames and
      // smears amplitude transients (classic WSOLA normalizes). The target
      // energy is constant across candidates, so it doesn't affect the argmax
      // and is omitted.
      const float score = dot / std::sqrt(energy + 1e-9f);
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
      const std::size_t abs = start + static_cast<std::size_t>(k);
      target_[static_cast<std::size_t>(k)] =
          (abs >= inBase_ && abs < inAvail()) ? inBuf_[abs - inBase_] : 0.0f;
    }
  }

  std::vector<float> process(bool finalPass) {
    // In the final pass, zero-pad the input so frame/search reads near the
    // end stay in bounds; we stop the loop by `inLenReal_`, so the padding
    // only ever contributes a negligible windowed tail.
    if (finalPass) {
      const std::size_t guardAbs =
          inLenReal_ + static_cast<std::size_t>(N_ + search_ + Hs_ + Ha_) + 1;
      if (inAvail() < guardAbs)
        inBuf_.resize(guardAbs - inBase_, 0.0f);
    }

    while (true) {
      if (firstFrame_) {
        if (inAvail() < static_cast<std::size_t>(N_))
          break; // need a full frame
        olaAddFrame(0);
        setTarget(0);
        anaIdeal_ = Ha_;
        outPos_ += static_cast<std::size_t>(Hs_);
        firstFrame_ = false;
        continue;
      }

      if (!finalPass) {
        // Need enough input that BOTH reads for this frame hit only real
        // samples (a ranges up to anaIdeal_ + search_):
        //   olaAddFrame(a): in[a .. a+N_)
        //   setTarget(a):   in[a+Hs_ .. a+Hs_+N_)   <- the +Hs_ read-ahead
        // Gating on the larger setTarget extent keeps the similarity target
        // from being zero-filled at a chunk boundary, so streamed output is
        // bit-identical to batch (no seams).
        const std::size_t needHi =
            static_cast<std::size_t>(anaIdeal_ + search_ + Hs_ + N_);
        if (inAvail() < needHi)
          break; // wait for more input
      } else if (anaIdeal_ >= static_cast<long>(inLenReal_)) {
        break; // consumed all real input
      }

      const std::size_t a = bestMatch(anaIdeal_, inAvail());
      olaAddFrame(a);
      setTarget(a);
      anaIdeal_ += Ha_;
      outPos_ += static_cast<std::size_t>(Hs_);
    }

    std::vector<float> out = finalize(finalPass);
    if (!finalPass)
      compactInput();
    return out;
  }

  // Emit the finalized prefix.  A sample at index j is final once no future
  // frame can write to it — future frames start at `outPos_`, so everything
  // below outPos_ is done.  On the final pass, emit the whole remaining tail.
  // After a non-final emit, drop the emitted prefix of acc_/norm_ so output
  // memory stays bounded (future writes are all at >= outPos_ == emitted_).
  std::vector<float> finalize(bool finalPass) {
    const std::size_t end =
        finalPass ? (outBase_ + acc_.size()) : outPos_; // absolute
    std::vector<float> out;
    if (end <= emitted_)
      return out;
    out.reserve(end - emitted_);
    for (std::size_t abs = emitted_; abs < end; ++abs) {
      const std::size_t i = abs - outBase_;
      const float n = norm_[i];
      out.push_back(n > 1e-6f ? acc_[i] / n : acc_[i]);
    }
    emitted_ = end;
    if (!finalPass) {
      const std::size_t drop = emitted_ - outBase_;
      if (drop > 0) {
        acc_.erase(
            acc_.begin(), acc_.begin() + static_cast<std::ptrdiff_t>(drop));
        norm_.erase(
            norm_.begin(), norm_.begin() + static_cast<std::ptrdiff_t>(drop));
        outBase_ = emitted_;
      }
    }
    return out;
  }

  // Drop input below the lowest absolute index any future frame can read.
  // The next frame's analysis ideal is `anaIdeal_`; its earliest read is at
  // `anaIdeal_ - search_` (bestMatch's lower search bound).
  void compactInput() {
    const std::size_t keepFrom =
        static_cast<std::size_t>(std::max<long>(0, anaIdeal_ - search_));
    if (keepFrom > inBase_) {
      inBuf_.erase(
          inBuf_.begin(),
          inBuf_.begin() + static_cast<std::ptrdiff_t>(keepFrom - inBase_));
      inBase_ = keepFrom;
    }
  }

  static constexpr float kPi = 3.14159265358979323846f;

  const int N_;
  const int Hs_;
  const int Ha_;
  const long search_;
  const std::vector<float> window_;

  std::vector<float>
      inBuf_;              // live input window; inBuf_[0] == abs index inBase_
  std::size_t inBase_ = 0; // absolute index of inBuf_[0]
  std::size_t inLenReal_ = 0; // total real samples fed (excludes final padding)
  std::vector<float> target_;

  std::vector<float> acc_; // output accumulator; acc_[0] == abs index outBase_
  std::vector<float> norm_;
  std::size_t outBase_ = 0; // absolute index of acc_[0]/norm_[0]
  std::size_t outPos_ = 0;  // absolute synthesis write position
  std::size_t emitted_ = 0; // absolute count of output already emitted
  long anaIdeal_ = 0;
  bool firstFrame_ = true;
};

} // namespace qvac::ttsggml::chatterbox
