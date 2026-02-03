'use strict'

const os = require('os')

// returns true when Android or OSX
function hasUnifiedMemory () {
  return os.platform() === 'darwin' || os.platform() === 'android'
}

function getDefaultSettings () {
  return {
    device: 'gpu',
    gpu_layers: '999'
  }
}

function getMixtral2x7bQ2Settings (environmentOverrides = {}) {
  const environment = {
    // TODO: Pass environment from system stats
    // By default configured for reasonable amount of VRAM
    vram: 8191,
    unified_memory: hasUnifiedMemory(),
    ...environmentOverrides
  }
  // With 8 GB vRAM with [0-10]% already in use, could
  // only load model with 27/32 layers on GPU.
  // Reaching 75% usage on nvtop. Lower batch size allows
  // to increase context size.
  const gpuLayers = environment.unified_memory || environment.vram >= 8192 + 2048 ? '999' : '27'
  const device = environment.unified_memory || environment.vram >= 8191
    ? {
        device: 'gpu',
        gpu_layers: gpuLayers
      }
    : {
        device: 'cpu'
      }
  const qualitySettings = {
    // Found with Llama.cpp:scripts/tune/tune_quality.py
    temp: '0.9',
    top_p: '0.85',
    top_k: '50',
    repeat_penalty: '1.3',
    repeat_last_n: '192',
    typical: '0.7'
  }
  const unifiedSettings = environment.unified_memory
    ? {
        kv_unified: '',
        flash_attn: ''
      }
    : {}
  return {
    ...qualitySettings,
    // Found with Llama.cpp:scripts/tune/tune_tps.py (8 GB vRAM)
    ...device,
    ...unifiedSettings,
    ctx_size: '2048',
    batch_size: '256',
    ubatch_size: '128',
    threads: gpuLayers === '999' ? '1' : '8'
  }
}

function getMixtral2x7bQ4Settings (environmentOverrides = {}) {
  const environment = {
    // TODO: Pass environment from system stats
    // By default configured for reasonable amount of VRAM
    vram: 8192,
    unified_memory: hasUnifiedMemory(),
    ...environmentOverrides
  }
  const gpuLayers = environment.unified_memory || environment.vram >= 8192 + 2048 ? '999' : '28'
  const device = environment.unified_memory || environment.vram >= 8191
    ? {
        device: 'gpu',
        gpu_layers: gpuLayers
      }
    : {
        device: 'cpu'
      }
  const qualitySettings = {
    // Found with Llama.cpp:scripts/tune/tune_quality.py
    temp: '0.3',
    top_p: '0.7',
    top_k: '30',
    min_p: '0.01',
    repeat_penalty: '1.25',
    repeat_last_n: '128',
    typical: '0.7'
  }
  const unifiedSettings = environment.unified_memory
    ? {
        batch_size: '128',
        ubatch_size: '32',
        kv_unified: '',
        flash_attn: ''
      }
    : {}
  return {
    ...qualitySettings,
    // Found with Llama.cpp:scripts/tune/tune_tps.py (8 GB vRAM)
    ...device,
    ...unifiedSettings,
    ctx_size: '2048',
    threads: gpuLayers === '999' ? '1' : '8'
  }
}

function getMixtral8x7bQ4Settings (environmentOverrides = {}) {
  // TODO: Pass environment from system stats
  //
  // This large model is not usable purely on CPU or without
  // enough GPU layers. Therefore, assume it will be run in
  // a GPU with 30 GB of vRAM (e.g. GTX 5080) or a device with
  // enough unified memory (in MacOS the peak resident size was 29.2 GB)
  //
  // Tokens per second on CPU or with low ammount of GPU layers is below 1 tps,
  // which is not acceptable. Use 2x7b models for devices with less memory available.
  const environment = {
    vram: 32768,
    unified_memory: false,
    ...environmentOverrides
  }
  const device = environment.unified_memory || environment.vram >= 32768
    ? {
        device: 'gpu',
        gpu_layers: '999'
      }
    : {
        device: 'cpu',
        // More computer power, however, many threads can freeze the device
        threads: '2'
      }
  if (device === 'cpu') {
    console.warn('Model might run extremely slow on CPU')
  }
  const unifiedSettings = environment.unified_memory
    ? {
        kv_unified: '',
        flash_attn: ''
      }
    : {}
  return {
    ...device,
    ...unifiedSettings
  }
}

function getSettingsFromMapping (modelName, environment, mapping) {
  for (const [key, value] of Object.entries(mapping)) {
    if (modelName.includes(key)) {
      return value(environment)
    }
  }
  return getDefaultSettings()
}

function getMixtralMoeSettings (modelName, environment = {}) {
  return getSettingsFromMapping(modelName, environment, {
    'dolphin-mixtral-2x7b-dop-Q2_K': getMixtral2x7bQ2Settings,
    'dolphin-mixtral-2x7b-dop-Q4_K_M': getMixtral2x7bQ4Settings,
    'Mixtral-8x7B-Instruct-v0.1.Q4_K_M': getMixtral8x7bQ4Settings
  })
}

module.exports = {
  getDefaultSettings,
  getMixtral2x7bQ2Settings,
  getMixtral2x7bQ4Settings,
  getMixtralMoeSettings
}
