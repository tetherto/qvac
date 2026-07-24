#pragma once

#include <array>
#include <cstdint>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

#include <lam-a2e.h>

namespace qvac_lib_inference_addon_sd {

/**
 * All load-time configuration for the LAM audio-to-expression context.
 *
 * Populated in AddonJs::createA2eInstance from the JS constructor args, then
 * consumed once in LamAudio2ExpressionModel::load() where LamAudio2Expression
 * wraps lam_a2e_create().
 */
struct LamAudio2ExpressionConfig {
  std::string modelPath; // model_path -- LAM audio2expression GGUF weights
  int32_t identityIndex{0}; // identity_index -- default identity/avatar slot
  int nThreads{-1};         // n_threads: -1 = auto-detect physical cores
  /** "cpu" or "gpu" — post-init truth is exposed via actualBackendDevice().
   * GPU is not yet implemented by the engine: requesting it is accepted here
   * for forward compatibility, but lam_a2e_create() will fail to load until
   * upstream enables GPU support. */
  std::string device{"cpu"};
  // Directory containing DL backend .so modules (mirrors SdCtxConfig; unused
  // until the engine's GPU path is wired up, kept for forward compatibility).
  std::string backendsDir;
};

/** One decoded ARKit-52 blendshape frame, timestamped in microseconds. */
struct LamA2eFrame {
  int64_t timestampUs{0};
  std::array<float, 52> arkit52{};
};

class LamAudio2Expression {
public:
  explicit LamAudio2Expression(LamAudio2ExpressionConfig config);

  LamAudio2Expression(const LamAudio2Expression&) = delete;
  LamAudio2Expression& operator=(const LamAudio2Expression&) = delete;
  LamAudio2Expression(LamAudio2Expression&&) = delete;
  LamAudio2Expression& operator=(LamAudio2Expression&&) = delete;

  ~LamAudio2Expression();

  void load();
  [[nodiscard]] bool isLoaded() const noexcept;
  /** 0 = CPU, 1 = GPU, -1 if not loaded. Reflects the backend that was
   * actually requested on the last successful lam_a2e_create() call (the
   * engine exposes no runtime backend query, unlike the ESRGAN upscaler). */
  [[nodiscard]] int actualBackendDevice() const;

  /**
   * Runs one PCM buffer through the loaded model and returns the decoded
   * ARKit-52 frames. @p sampleRate must be 16000 (enforced by the engine).
   * @p identityIndexOverride, when set and different from the currently
   * loaded identity, transparently recreates the underlying context with the
   * new identity — the engine only accepts identity_index at creation time.
   */
  std::vector<LamA2eFrame> processPcmF32(
      const std::vector<float>& pcm, int32_t sampleRate,
      std::optional<int32_t> identityIndexOverride = std::nullopt);

private:
  [[nodiscard]] int resolveThreads() const;
  /** Assumes mutex_ is already held by the caller. */
  lam_a2e_context* ensureContextLocked(int32_t identityIndex);

  const LamAudio2ExpressionConfig config_;
  std::unique_ptr<lam_a2e_context, decltype(&lam_a2e_free)> ctx_;
  int32_t currentIdentityIndex_;
  bool useGpuActive_{false};
  mutable std::mutex mutex_;
};

} // namespace qvac_lib_inference_addon_sd
