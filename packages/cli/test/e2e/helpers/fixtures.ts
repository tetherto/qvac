// Test fixtures for the e2e suite.

// 1x1 transparent PNG, for multipart image tests.
export function tinyPng(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
}

// 1-second 16 kHz mono 16-bit PCM silent WAV, for transcription/translation.
export function silenceWav(): Buffer {
  const b = Buffer.alloc(32044)
  b.write('RIFF', 0)
  b.writeUInt32LE(32036, 4)
  b.write('WAVE', 8)
  b.write('fmt ', 12)
  b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20)
  b.writeUInt16LE(1, 22)
  b.writeUInt32LE(16000, 24)
  b.writeUInt32LE(32000, 28)
  b.writeUInt16LE(2, 32)
  b.writeUInt16LE(16, 34)
  b.write('data', 36)
  b.writeUInt32LE(32000, 40)
  return b
}

export function textFile(content: string): Buffer {
  return Buffer.from(content, 'utf8')
}
