import fs = require('bare-fs')
import os = require('bare-os')
import path = require('bare-path')

import type { RuntimeConfig } from './protocol'

export * from './protocol'
export * from './worker-manager'

export interface MiniMaxDiffusersOptions {
  modelDir: string
  cacheDir?: string
  pythonPath?: string
}

function requireAbsoluteDirectory (value: string, name: string): string {
  if (!path.isAbsolute(value)) {
    throw new TypeError(`${name} must be an absolute path`)
  }
  if (!fs.statSync(value).isDirectory()) {
    throw new TypeError(`${name} must be an existing directory`)
  }
  return value
}

export function resolveRuntimeConfig (options: MiniMaxDiffusersOptions): RuntimeConfig {
  if (os.platform() === 'android' || os.platform() === 'ios') {
    throw new Error('MiniMax-Music3 Diffusers requires a desktop CUDA runtime')
  }
  const modelDir = requireAbsoluteDirectory(options.modelDir, 'modelDir')
  const cacheDir = options.cacheDir === undefined
    ? undefined
    : requireAbsoluteDirectory(options.cacheDir, 'cacheDir')
  return { modelDir, cacheDir, device: 'cuda', torchDtype: 'bfloat16' }
}
