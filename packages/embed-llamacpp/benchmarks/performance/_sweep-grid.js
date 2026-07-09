'use strict'

// Single source of truth for the desktop sweep axes, shared by the Bare sweep
// (config + case-runner) and the Node renderer (coverage denominator). Plain
// literals only — no bare-fs/fs imports — so it loads in both runtimes.
//
// A case is (model x quant x batchSize x flashAttn): one configuration each, no
// input-mode or sequence-count axis. The per-case input is derived from the
// batch size and the model's trained context in the sweep (see case-runner.js).
const PARAMETER_SWEEP = {
  quantization: ['Q4_0', 'Q4_K_M', 'Q8_0', 'F16'],
  // Desktop is GPU-only, matching the LLM benchmark (its getDefaultSweepDevices
  // returns ['gpu'] off Android). CPU embedding of the large-batch configs is
  // impractical and isn't a real desktop use case; CPU is covered on mobile.
  device: ['gpu'],
  batchSize: [256, 512, 1024, 2048, 4096, 8192],
  flashAttn: ['off', 'on']
}

module.exports = { PARAMETER_SWEEP }
