import type { Check } from '@/doctor/check'

export const checkFfmpeg: Check = (ctx) => {
  const r = ctx.probe('ffmpeg', ['-version'])
  if (!r.ok) {
    return {
      id: 'tool-ffmpeg',
      label: 'ffmpeg',
      status: 'warn',
      severity: 'recommended',
      value: 'not found',
      hint: 'Install ffmpeg to use transcription / microphone examples (https://ffmpeg.org/download.html).'
    }
  }
  return {
    id: 'tool-ffmpeg',
    label: 'ffmpeg',
    status: 'pass',
    severity: 'recommended',
    value: r.version ?? 'installed'
  }
}

export const checkBareRuntime: Check = (ctx) => {
  const r = ctx.probe('bare', ['--version'])
  if (!r.ok) {
    return {
      id: 'tool-bare',
      label: 'Bare runtime',
      status: 'warn',
      severity: 'recommended',
      value: 'not found',
      hint: 'Install bare-runtime only if you target the Bare runtime directly (npm i -g bare-runtime).'
    }
  }
  return {
    id: 'tool-bare',
    label: 'Bare runtime',
    status: 'pass',
    severity: 'recommended',
    value: r.version ?? 'installed'
  }
}
