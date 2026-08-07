'use strict'

// Input-space coverage for the ABot-World walk session that needs no models
// and no GPU: the action-mask mapping every demo keypress goes through, and
// the createScene/constructor validation layer (all of it throws before the
// native addon is ever created). The GPU integration suite covers the same
// surfaces end-to-end but only for a handful of values; the full matrix
// lives here where it costs milliseconds.

const path = require('bare-path')
const test = require('brittle')
const WorldStableDiffusion = require('../../world.js')
const { toActionMask, KEY_ORDER } = require('../../world.js')

const ABS = path.resolve('/models')
const FILES = {
  model: path.join(ABS, 'dit.gguf'),
  taehv: path.join(ABS, 'taehv.gguf'),
  scene: path.join(ABS, 'scene.safetensors')
}
const SCENE_OK = {
  prompt: '| unknown | test scene',
  image: new Uint8Array([1, 2, 3]),
  t5: path.join(ABS, 't5.gguf'),
  vae: path.join(ABS, 'vae.gguf'),
  output: path.join(ABS, 'out.safetensors')
}

test('toActionMask: full key matrix, input forms, and rejection', async function (t) {
  // every key maps to its documented bit, case-insensitively, in both forms
  for (let bit = 0; bit < KEY_ORDER.length; bit++) {
    const key = KEY_ORDER[bit]
    t.is(toActionMask({ [key]: true }), 1 << bit, `object form: ${key} -> bit ${bit}`)
    t.is(toActionMask([key.toLowerCase()]), 1 << bit, `array form: ${key.toLowerCase()}`)
  }

  // combos: move + camera, the demo's common chords
  t.is(toActionMask({ W: true, L: true }), 0b10000001, 'W+L combo')
  t.is(toActionMask(['S', 'J']), 0b00100100, 'S+J combo (array)')
  t.is(toActionMask({ W: true, A: false, S: 0 }), 0b00000001, 'falsy values ignored')

  // raw masks pass through; idle forms
  t.is(toActionMask(0), 0, 'raw 0')
  t.is(toActionMask(255), 255, 'raw 255')
  t.is(toActionMask({}), 0, 'empty object = idle')
  t.is(toActionMask([]), 0, 'empty array = idle')

  // rejection: unknown keys and out-of-range masks
  await t.exception.all(() => toActionMask({ Q: true }), /unknown walk key/, 'unknown key throws')
  await t.exception.all(
    () => toActionMask(['W', 'up']),
    /unknown walk key/,
    'unknown array key throws'
  )
  await t.exception.all(() => toActionMask(-1), /\[0, 255\]/, 'negative mask throws')
  await t.exception.all(() => toActionMask(256), /\[0, 255\]/, 'mask > 255 throws')
  await t.exception.all(() => toActionMask(1.5), /\[0, 255\]/, 'non-integer mask throws')
})

test('constructor: file-path validation', async function (t) {
  await t.exception.all(
    () => new WorldStableDiffusion({}),
    /files must be an object/,
    'missing files'
  )
  await t.exception.all(
    () => new WorldStableDiffusion({ files: { ...FILES, model: 'dit.gguf' } }),
    /absolute path/,
    'relative model path'
  )
  await t.exception.all(
    () => new WorldStableDiffusion({ files: { ...FILES, scene: '' } }),
    /absolute path/,
    'empty scene path'
  )
  t.execution(() => new WorldStableDiffusion({ files: FILES }), 'absolute paths accepted')
})

test('createScene: parameter validation happens before any native call', async function (t) {
  const world = new WorldStableDiffusion({ files: FILES })

  await t.exception.all(
    async () => world.createScene(null),
    /params must be an object/,
    'null params'
  )
  await t.exception.all(
    async () => world.createScene({ ...SCENE_OK, t5: 't5.gguf' }),
    /absolute path/,
    'relative t5 path'
  )
  await t.exception.all(
    async () => world.createScene({ ...SCENE_OK, prompt: '' }),
    /non-empty string/,
    'empty prompt'
  )
  await t.exception.all(
    async () => world.createScene({ ...SCENE_OK, image: new Uint8Array(0) }),
    /non-empty Uint8Array/,
    'empty image bytes'
  )
  await t.exception.all(
    async () => world.createScene({ ...SCENE_OK, image: 'not-bytes' }),
    /Uint8Array/,
    'non-buffer image'
  )
  await t.exception.all(
    async () => world.createScene({ ...SCENE_OK, width: 830 }),
    /multiples of 32/,
    'width not a multiple of 32'
  )
  await t.exception.all(
    async () => world.createScene({ ...SCENE_OK, height: 100 }),
    /multiples of 32/,
    'height not a multiple of 32'
  )
  await t.exception.all(
    async () => world.createScene({ ...SCENE_OK, width: -32 }),
    /positive multiples of 32/,
    'negative width (multiple of 32) throws'
  )
  await t.exception.all(
    async () => world.createScene({ ...SCENE_OK, height: 0 }),
    /positive multiples of 32/,
    'zero height throws instead of silently defaulting'
  )
  await t.exception.all(
    async () => world.createScene({ ...SCENE_OK, width: 831.5 }),
    /positive multiples of 32/,
    'non-integer width throws'
  )
})

test('constructor: frameJpegQuality range validation', async function (t) {
  await t.exception.all(
    () => new WorldStableDiffusion({ files: FILES, config: { frameJpegQuality: 101 } }),
    /\[0, 100\]/,
    'quality > 100 throws'
  )
  await t.exception.all(
    () => new WorldStableDiffusion({ files: FILES, config: { frameJpegQuality: -1 } }),
    /\[0, 100\]/,
    'negative quality throws'
  )
  await t.exception.all(
    () => new WorldStableDiffusion({ files: FILES, config: { frameJpegQuality: 42.5 } }),
    /\[0, 100\]/,
    'non-integer quality throws'
  )
  t.execution(
    () => new WorldStableDiffusion({ files: FILES, config: { frameJpegQuality: 0 } }),
    '0 (PNG) accepted'
  )
  t.execution(
    () => new WorldStableDiffusion({ files: FILES, config: { frameJpegQuality: 85 } }),
    '85 accepted'
  )
})

test('ActionFlag: named bits agree with KEY_ORDER and toActionMask', function (t) {
  const { ActionFlag } = WorldStableDiffusion
  t.is(ActionFlag.None, 0, 'None is 0')
  KEY_ORDER.forEach((key, bit) => {
    t.is(ActionFlag[key], 1 << bit, `ActionFlag.${key} is bit ${bit}`)
    t.is(toActionMask([key]), ActionFlag[key], `toActionMask(['${key}']) matches ActionFlag.${key}`)
  })
  t.is(
    toActionMask(ActionFlag.W | ActionFlag.L),
    ActionFlag.W | ActionFlag.L,
    'OR-combined flags pass through as a raw mask'
  )
})

test('step: rejects before load()', async function (t) {
  const world = new WorldStableDiffusion({ files: FILES })
  await t.exception.all(
    async () => world.step({ W: true }),
    /before load/,
    'step before load throws'
  )
})
