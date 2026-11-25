'use strict'

const os = require('bare-os')
const proc = require('bare-process')

const platform = os.platform()
const isMobile = platform === 'ios' || platform === 'android'
const isApple = platform === 'darwin' || platform === 'ios'

const NO_GPU = !!proc.env && proc.env.NO_GPU === 'true'
const GPU_ONLY_USE_GPU = !isMobile
const SKIP_PARLER_GPU_ONLY = NO_GPU || (!isMobile && !isApple)
const PARLER_GPU_ONLY_USE_GPU = isApple && !isMobile
const PARLER_DETERMINISM_DESKTOP = isApple || platform === 'linux'
const SKIP_PARLER_DETERMINISM = NO_GPU || (!isMobile && !PARLER_DETERMINISM_DESKTOP)
const PARLER_DETERMINISM_USE_GPU = PARLER_DETERMINISM_DESKTOP && !isMobile

module.exports = {
  NO_GPU,
  GPU_ONLY_USE_GPU,
  SKIP_PARLER_GPU_ONLY,
  PARLER_GPU_ONLY_USE_GPU,
  SKIP_PARLER_DETERMINISM,
  PARLER_DETERMINISM_USE_GPU
}
