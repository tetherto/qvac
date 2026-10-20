'use strict'

const test = require('brittle')
const process = require('bare-process')
const { toVoiceControlsCatalog } = require('../../lib/voiceControls.js')

global.process = process

test('voice controls catalog: tts-cpp engine names map to engine types and the tables are copied', (t) => {
  const native = {
    emotions: ['happy', 'sad'],
    paces: ['slow', 'fast'],
    engines: {
      cosyvoice: { emotions: ['sad'], paces: ['slow'] },
      parler: { emotions: ['happy', 'sad'], paces: ['slow', 'fast'] },
      'future-engine': { emotions: [], paces: [] }
    }
  }
  const catalog = toVoiceControlsCatalog(native)
  t.alike(Object.keys(catalog.engines), ['cosyvoice3', 'parler', 'future-engine'])
  t.alike(catalog.engines.cosyvoice3, { emotions: ['sad'], paces: ['slow'] })
  t.alike(catalog.emotions, ['happy', 'sad'])
  t.alike(catalog.paces, ['slow', 'fast'])
  catalog.emotions.push('angry')
  catalog.engines.parler.paces.pop()
  t.alike(native.emotions, ['happy', 'sad'], 'the native vocabulary is not shared with callers')
  t.alike(native.engines.parler.paces, ['slow', 'fast'])
})
