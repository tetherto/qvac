'use strict'

// Research settings, not production defaults. Identical inputs on each platform.
exports.settings = Object.freeze({
  maxSide: 448,
  fps: 1,
  maxFrames: 32,
  context: 8192,
  maxVideoSeconds: 60,
  maxDownloadBytes: 260 * 1024 * 1024,
  predictionTokens: 48,
  imageMaxTokens: 140,
  seed: 42
})

exports.clips = [
  {
    id: 'bbb-720p',
    file: 'bbb-720p.mp4',
    limitSeconds: 10,
    url: 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_5MB.mp4',
    sha256: 'bfb0b4b07b8bb61b707a052e62daec31305a13276fcbebc714f2462f31d96210',
    source: 'Big Buck Bunny / Blender Foundation, synthetic animation, H.264 SDR'
  },
  {
    id: 'iphone-1080p',
    file: 'iphone-1080p.mov',
    limitSeconds: 60,
    url: 'https://img.photographyblog.com/reviews/apple_iphone_13_pro/sample_images/FullHD30p.mov',
    bytes: 20466446,
    sha256: '472edd28e6987c326b49c72354a40f0edf7cef7560df8a201830ac3386f1f116',
    source: 'Photography Blog, original iPhone 13 Pro, HEVC Main10 Dolby Vision 8.4 / HLG'
  },
  {
    id: 'xperia-4k',
    file: 'xperia-4k.mp4',
    limitSeconds: 60,
    url: 'https://img.photographyblog.com/reviews/sony_xperia_1_iv/sample_images/sony_xperia_1_iv_03_4k_120fps.mp4',
    bytes: 244656425,
    sha256: '970d8c7843fd841f994587efa90fd9542fb5af6de4db6c882afc84b62894bd89',
    source:
      'Photography Blog, original Xperia 1 IV, HEVC Main10 HLG; first 60 seconds only, no re-encode'
  }
]

exports.models = [
  {
    id: 'qwen35',
    modelName: 'Qwen3.5-0.8B-Q8_0.gguf',
    projectorName: 'mmproj-Qwen3.5-0.8B-F16.gguf'
  },
  {
    id: 'gemma4',
    modelName: 'google_gemma-4-E2B-it-Q4_K_M.gguf',
    projectorName: 'mmproj-google_gemma-4-E2B-it-f16.gguf'
  }
]

exports.question =
  'These are chronological frames from one video. Briefly describe the visible scene and what changes over time. Do not invent sounds. Answer in at most two sentences.'
