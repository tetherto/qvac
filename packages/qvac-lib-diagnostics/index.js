'use strict'

let _os
try {
  _os = require('bare-os')
} catch (e) {
  try {
    _os = require('os')
  } catch (e2) {
    _os = null
  }
}

let _process
if (typeof global !== 'undefined' && global.process) {
  _process = global.process
} else {
  try {
    _process = require('process')
  } catch (e) {
    try {
      _process = require('bare-process')
    } catch (e2) {
      _process = null
    }
  }
}

/**
 * Version of the diagnostic report format
 * @type {string}
 */
const REPORT_VERSION = '1.0.0'

/**
 * @typedef {Object} AppInfo
 * @property {string} name - Application name
 * @property {string} version - Application version
 */

/**
 * @typedef {Object} EnvironmentInfo
 * @property {string} os - Operating system platform
 * @property {string} arch - CPU architecture
 * @property {string} osVersion - OS version/release string
 * @property {string} runtime - Runtime environment (e.g. 'bare', 'node')
 */

/**
 * @typedef {Object} HardwareInfo
 * @property {string} cpuModel - CPU model name
 * @property {number} cpuCores - Number of CPU cores
 * @property {number} totalMemoryMB - Total system memory in megabytes
 */

/**
 * @typedef {Object} AddonEntry
 * @property {string} name - Addon name
 * @property {string} version - Addon version
 * @property {string} diagnostics - Opaque JSON string returned by getDiagnostics callback
 */

/**
 * @typedef {Object} ExtensionSection
 * @property {string} name - Extension name
 * @property {*} data - Extension data (any JSON-serializable value)
 */

/**
 * @typedef {Object} DiagnosticReport
 * @property {string} reportVersion - Report format version
 * @property {string} generatedAt - ISO timestamp when report was generated
 * @property {AppInfo} app - Application information
 * @property {EnvironmentInfo} environment - Environment information
 * @property {HardwareInfo} hardware - Hardware information
 * @property {AddonEntry[]} addons - Registered addon diagnostics
 * @property {ExtensionSection[]} extensions - Registered extension sections
 */

/**
 * Singleton addon registry: name -> { version, getDiagnostics }
 * @private
 * @type {Map<string, { version: string, getDiagnostics: () => string }>}
 */
const _addonRegistry = new Map()

/**
 * Singleton extension registry: name -> data
 * @private
 * @type {Map<string, *>}
 */
const _extensions = new Map()

/**
 * Registers an addon that can contribute diagnostics to the report.
 * The getDiagnostics callback will be called at report generation time
 * and must return an opaque JSON string.
 *
 * @param {{ name: string, version: string, getDiagnostics: () => string }} addon
 */
function registerAddon (addon) {
  if (!addon || typeof addon.name !== 'string' || !addon.name) {
    throw new Error('addon.name must be a non-empty string')
  }
  if (typeof addon.version !== 'string') {
    throw new Error('addon.version must be a string')
  }
  if (typeof addon.getDiagnostics !== 'function') {
    throw new Error('addon.getDiagnostics must be a function')
  }
  _addonRegistry.set(addon.name, {
    version: addon.version,
    getDiagnostics: addon.getDiagnostics
  })
}

/**
 * Unregisters a previously registered addon.
 *
 * @param {string} name - Addon name to remove
 */
function unregisterAddon (name) {
  _addonRegistry.delete(name)
}

/**
 * Registers an extension section to be included in the report.
 *
 * @param {string} name - Extension section name
 * @param {*} data - Extension data (any JSON-serializable value)
 */
function registerExtension (name, data) {
  if (typeof name !== 'string' || !name) {
    throw new Error('extension name must be a non-empty string')
  }
  _extensions.set(name, data)
}

/**
 * Collects environment information from the current runtime.
 *
 * @returns {EnvironmentInfo}
 */
function collectEnvironment () {
  let os = 'unknown'
  let arch = 'unknown'
  let osVersion = 'unknown'
  let runtime = 'unknown'

  if (_os) {
    try {
      os = typeof _os.platform === 'function' ? _os.platform() : String(_os.platform || 'unknown')
    } catch (e) {
      os = 'unknown'
    }
    try {
      arch = typeof _os.arch === 'function' ? _os.arch() : String(_os.arch || 'unknown')
    } catch (e) {
      arch = 'unknown'
    }
    try {
      osVersion = typeof _os.release === 'function' ? _os.release() : String(_os.release || 'unknown')
    } catch (e) {
      osVersion = 'unknown'
    }
  }

  if (_process) {
    try {
      const ver = _process.version || 'unknown'
      const plat = _process.platform || os
      runtime = plat === 'android' || plat === 'ios' ? 'bare' : (typeof Bare !== 'undefined' ? 'bare' : 'node')
      if (runtime === 'node') {
        runtime = 'node ' + ver
      } else {
        runtime = 'bare ' + ver
      }
    } catch (e) {
      runtime = 'unknown'
    }
  }

  return { os, arch, osVersion, runtime }
}

/**
 * Collects hardware information from the current system.
 *
 * @returns {HardwareInfo}
 */
function collectHardware () {
  let cpuModel = 'unknown'
  let cpuCores = 0
  let totalMemoryMB = 0

  if (_os) {
    try {
      const cpuList = typeof _os.cpus === 'function' ? _os.cpus() : []
      if (cpuList && cpuList.length > 0) {
        cpuModel = cpuList[0].model || 'unknown'
        cpuCores = cpuList.length
      }
    } catch (e) {
      cpuModel = 'unknown'
      cpuCores = 0
    }
    try {
      const totalBytes = typeof _os.totalmem === 'function' ? _os.totalmem() : 0
      totalMemoryMB = Math.floor(totalBytes / (1024 * 1024))
    } catch (e) {
      totalMemoryMB = 0
    }
  }

  return { cpuModel, cpuCores, totalMemoryMB }
}

/**
 * Generates a full diagnostic report.
 *
 * @param {{ app: AppInfo }} opts
 * @returns {DiagnosticReport}
 */
function generateReport (opts) {
  const app = (opts && opts.app) ? opts.app : { name: 'unknown', version: 'unknown' }
  const environment = collectEnvironment()
  const hardware = collectHardware()

  const addons = []
  for (const [name, entry] of _addonRegistry) {
    let diagnostics = ''
    try {
      diagnostics = entry.getDiagnostics()
    } catch (e) {
      diagnostics = JSON.stringify({ error: String(e) })
    }
    addons.push({ name, version: entry.version, diagnostics })
  }

  const extensions = []
  for (const [name, data] of _extensions) {
    extensions.push({ name, data })
  }

  return {
    reportVersion: REPORT_VERSION,
    generatedAt: new Date().toISOString(),
    app,
    environment,
    hardware,
    addons,
    extensions
  }
}

/**
 * Serializes a diagnostic report to a JSON string.
 *
 * @param {DiagnosticReport} report
 * @returns {string}
 */
function serializeReport (report) {
  return JSON.stringify(report, null, 2)
}

/**
 * Resets all singleton state (addon registry and extensions).
 * Primarily useful for testing.
 */
function reset () {
  _addonRegistry.clear()
  _extensions.clear()
}

module.exports = {
  REPORT_VERSION,
  registerAddon,
  unregisterAddon,
  registerExtension,
  collectEnvironment,
  collectHardware,
  generateReport,
  serializeReport,
  reset
}
