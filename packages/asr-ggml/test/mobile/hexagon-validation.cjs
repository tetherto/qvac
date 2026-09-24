'use strict'

function requireCondition(condition, message) {
  if (!condition) throw new Error(message)
}

function words(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9' ]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

function wordErrorRate(reference, hypothesis) {
  const expected = words(reference)
  const actual = words(hypothesis)
  requireCondition(expected.length > 0, 'A nonempty reference transcript is required')
  let row = Array.from({ length: actual.length + 1 }, (_, i) => i)
  for (let i = 0; i < expected.length; i++) {
    const next = [i + 1]
    for (let j = 0; j < actual.length; j++) {
      next.push(Math.min(next[j] + 1, row[j + 1] + 1, row[j] + (expected[i] === actual[j] ? 0 : 1)))
    }
    row = next
  }
  return row[actual.length] / expected.length
}

function assertBackend(backend, info, stats) {
  const expected = { cpu: [0, 0, 'CPU'], opencl: [4, 1, 'GPU'], hexagon: [5, 2, 'NPU'] }[backend]
  requireCondition(
    expected && info && stats,
    'Native backend information and runtime stats are required'
  )
  requireCondition(
    info.backendId === expected[0] && stats.backendId === expected[0],
    `${backend}: wrong backend family`
  )
  requireCondition(
    info.backendDevice === expected[2] && stats.backendDevice === expected[1],
    `${backend}: wrong device class`
  )
  requireCondition(
    !stats.gpuUnsupported && !info.encoderOnCoreml,
    `${backend}: unexpected fallback or CoreML encoder`
  )
  if (backend === 'hexagon') {
    requireCondition(info.backendName === 'HTP0', 'Hexagon must select HTP0')
  }
  for (const key of ['encoderMs', 'decoderMs', 'totalWallMs', 'audioDurationMs']) {
    requireCondition(Number.isFinite(stats[key]) && stats[key] >= 0, `Missing or invalid ${key}`)
  }
  requireCondition(
    stats.encoderMs > 0 && stats.audioDurationMs > 0,
    'No measured encoder inference'
  )
}

function profileEvidence(messages) {
  const result = { im2col: 0, conv2dDw: 0, hmxMatmul: 0 }
  for (const message of messages) {
    if (!/ggml-hex: HTP0 profile-op /.test(message) || !/cycles [1-9][0-9]*/.test(message)) continue
    if (/profile-op IM2COL\|/.test(message)) result.im2col++
    if (/profile-op CONV_2D_DW\|/.test(message)) result.conv2dDw++
    if (/profile-op MUL_MAT\|/.test(message) && /hmx-tiled/.test(message)) result.hmxMatmul++
  }
  for (const [key, count] of Object.entries(result)) {
    requireCondition(count > 0, `Missing executed Hexagon ${key} profile evidence`)
  }
  return result
}

function assertEnvironment(env, mode) {
  requireCondition(
    env.GGML_HEXAGON_OPSTAGE === undefined || (Number(env.GGML_HEXAGON_OPSTAGE) & 3) === 3,
    'Hexagon queue and compute stages must both be enabled'
  )
  for (const key of ['GGML_HEXAGON_USE_HMX', 'GGML_HEXAGON_NHMX']) {
    requireCondition(env[key] === undefined || Number(env[key]) > 0, `${key} must enable HMX`)
  }
  if (mode === 'timing') {
    for (const key of [
      'GGML_HEXAGON_PROFILE',
      'GGML_HEXAGON_VERBOSE',
      'GGML_HEXAGON_ETM',
      'GGML_HEXAGON_OPTRACE'
    ]) {
      requireCondition(env[key] === undefined || env[key] === '0', `Disable ${key} for timing`)
    }
  } else {
    requireCondition(
      env.GGML_HEXAGON_PROFILE === '1',
      'Profile mode requires GGML_HEXAGON_PROFILE=1'
    )
  }
}

module.exports = {
  requireCondition,
  wordErrorRate,
  assertBackend,
  profileEvidence,
  assertEnvironment
}
