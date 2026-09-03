import test from 'brittle'
import {
  CalibrationAbortedError,
  DESKTOP_CALIBRATION_PROFILE,
  MOBILE_CALIBRATION_PROFILE,
  calibrationLoadMode,
  calibrationProfileFor,
  deriveCalibration,
  fixtureSource,
  forcesCpu,
  isMobileCalibrationPlatform,
  predictedUpperBytes
} from '@/resources/model-fit/calibration/harness'
import type { ResidentFit } from '@/resources/model-fit/calibration/fit'

const MIB = 1024 * 1024

const FIT: ResidentFit = {
  weightRatio: 0.95,
  fixedBytes: 100 * MIB,
  perTokenBytes: 1000,
  worstExcessBytes: 20 * MIB
}

test('mobile platforms get the mobile profile, everything else the desktop one', (t) => {
  t.is(calibrationProfileFor('android-arm64'), MOBILE_CALIBRATION_PROFILE)
  t.is(calibrationProfileFor('ios-arm64'), MOBILE_CALIBRATION_PROFILE)
  t.is(calibrationProfileFor('darwin-arm64'), DESKTOP_CALIBRATION_PROFILE)
  t.is(calibrationProfileFor('linux-x64'), DESKTOP_CALIBRATION_PROFILE)
  t.ok(isMobileCalibrationPlatform('android-arm64'))
  t.absent(isMobileCalibrationPlatform('darwin-arm64'))
})

test('mobile profile keeps every load below a phone budget', (t) => {
  // The held-out model is the largest load of the run; 4B Q4 at 4096 tokens
  // stays under the ~3 GiB iOS per-process ceiling with room for the app.
  t.is(MOBILE_CALIBRATION_PROFILE.heldOutModel, 'QWEN3_4B_INST_Q4_K_M')
  t.is(MOBILE_CALIBRATION_PROFILE.contexts[1], 4096)
  t.absent(MOBILE_CALIBRATION_PROFILE.fitModels.includes('QWEN3_8B_INST_Q4_K_M'))
})

test('platforms whose counter cannot follow the GPU calibrate CPU-resident', (t) => {
  t.ok(forcesCpu('linux-x64'))
  t.ok(forcesCpu('win32-x64'))
  t.ok(forcesCpu('darwin-x64'))
  // Mobile is unified memory, but Android RSS still did not see a GPU-resident
  // load, and the collector cannot name the device to subtract the right cache.
  t.ok(forcesCpu('android-arm64'))
  t.ok(forcesCpu('ios-arm64'))
  // Apple silicon is the one unified-memory platform where RSS does follow the
  // GPU, so it keeps it.
  t.absent(forcesCpu('darwin-arm64'))
})

test('the anonymous load follows the forced CPU backend, not the OS', (t) => {
  t.is(calibrationLoadMode('linux-x64'), 'none')
  t.is(calibrationLoadMode('win32-x64'), 'none')
  t.is(calibrationLoadMode('darwin-x64'), 'none')
  t.is(calibrationLoadMode('android-arm64'), 'none')
  t.is(calibrationLoadMode('ios-arm64'), 'none')
  t.is(calibrationLoadMode('darwin-arm64'), undefined, 'the GPU pass keeps the mapped load')
})

test('deriveCalibration widens the fit into bounds and floors the ratio at 1', (t) => {
  const calibration = deriveCalibration(FIT, {
    backend: 'metal',
    device: 'Apple A18',
    kvElementBytes: 1.0625,
    worstWorkingBytes: 10 * MIB
  })

  t.is(calibration.weightUpperCoeff, 1.01, 'the ratio floors at 1, then takes its slack margin')
  t.is(calibration.workingPeakBytes?.upper, Math.round(10 * MIB * 1.2))
  t.is(calibration.fixedOverheadBytes.lower, Math.round(80 * MIB))
  t.is(
    calibration.fixedOverheadBytes.upper,
    Math.round(120 * MIB * 1.2),
    'upper floored at the worst observed excess before widening'
  )
  t.is(calibration.computeBufferBytesPerToken.lower, 800)
  t.is(calibration.computeBufferBytesPerToken.upper, 1200)
  t.is(calibration.validated, false, 'the held-out check decides validation, not the fit')
  t.alike(calibration.audioWindowBytes, { lower: 0, upper: 0 })
  t.is(calibration.measuredOn?.backend, 'metal')
  t.is(calibration.measuredOn?.device, 'Apple A18')
  t.is(calibration.measuredOn?.kvElementBytes, 1.0625)
  t.is(calibration.notes, undefined, 'a default mmap load needs no note')
})

test('deriveCalibration records an anonymous weight load', (t) => {
  const calibration = deriveCalibration(
    { ...FIT, weightRatio: 1.02 },
    { backend: 'cpu', kvElementBytes: 2, worstWorkingBytes: 0, loadMode: 'none' }
  )

  t.is(calibration.weightUpperCoeff, 1.03, 'the fitted ratio carries its 1% slack')
  t.is(calibration.measuredOn?.device, undefined)
  t.is(calibration.notes?.length, 1)
  t.ok(calibration.notes?.[0]?.includes("load_mode 'none'"))
})

test('predictedUpperBytes is the estimator upper bound for one load', (t) => {
  // Non-zero working peak: it is a term of the prediction, and a zero here
  // would let the estimator drop it without the test noticing.
  const calibration = deriveCalibration(FIT, {
    backend: 'cpu',
    kvElementBytes: 2,
    worstWorkingBytes: 8 * MIB
  })
  const artifact = 2 * 1024 * MIB
  const kv = 512 * MIB
  const expected =
    artifact * calibration.weightUpperCoeff +
    calibration.fixedOverheadBytes.upper +
    calibration.computeBufferBytesPerToken.upper * 4096 +
    calibration.workingPeakBytes!.upper +
    kv
  t.ok(calibration.workingPeakBytes!.upper > 0)
  t.is(predictedUpperBytes(calibration, artifact, 4096, kv), expected)
})

test('fixtureSource is a committable module named after the platform', (t) => {
  const calibration = deriveCalibration(FIT, {
    backend: 'vulkan',
    kvElementBytes: 2,
    worstWorkingBytes: 0
  })
  const source = fixtureSource('android-arm64', calibration)

  t.ok(source.includes('export const ANDROID_ARM64_CALIBRATION: PlatformCalibration = {'))
  // Spelled in pieces so tsc-alias does not rewrite the expected specifier.
  const typesModule = ['@', 'resources', 'model-fit', 'types'].join('/')
  t.ok(
    source.includes(`import type { PlatformCalibration } from '${typesModule}'`),
    'the fixture imports through the alias, not a compiled relative path'
  )
  t.ok(source.includes('backend: "vulkan"'), 'values stay JSON-quoted; prettier settles the style')
  t.absent(source.includes('"backend":'), 'keys are unquoted')
})

test('a GPU fixture is keyed by backend so it cannot overwrite the CPU one', (t) => {
  const calibration = deriveCalibration(FIT, {
    backend: 'vulkan',
    kvElementBytes: 1.0625,
    worstWorkingBytes: 0
  })
  const source = fixtureSource('linux-x64-vulkan', calibration)

  t.ok(source.includes('export const LINUX_X64_VULKAN_CALIBRATION: PlatformCalibration = {'))
  t.absent(source.includes('LINUX_X64_CALIBRATION:'), 'the CPU fixture keeps its own constant')
})

test('fixtureSource leaves quotes inside a value alone', (t) => {
  const calibration = deriveCalibration(FIT, {
    backend: 'cpu',
    kvElementBytes: 2,
    worstWorkingBytes: 0,
    loadMode: 'none'
  })
  const source = fixtureSource('linux-x64', calibration)

  t.ok(
    source.includes("load_mode 'none'"),
    'unquoting every quote would have closed the note early'
  )
})

test('CalibrationAbortedError carries a stable reason', (t) => {
  const error = new CalibrationAbortedError('degenerate-fit', 'cannot separate the coefficients')
  t.ok(error instanceof Error)
  t.is(error.name, 'CalibrationAbortedError')
  t.is(error.reason, 'degenerate-fit')
  t.is(error.message, 'cannot separate the coefficients')
})
