'use strict'

const path = require('path')
const {
  ALLOWED_LICENSES,
  LICENSE_NORMALIZE_MAP,
  COPYRIGHT_HOLDER,
  COPYRIGHT_YEAR
} = require('../constants')

// ---------------------------------------------------------------------------
// Resolve the monorepo root (four levels up from this file)
// ---------------------------------------------------------------------------
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..')

const PACKAGES_DIR = path.join(REPO_ROOT, 'packages')

const MODELS_JSON_PATH = path.join(
  PACKAGES_DIR, 'qvac-lib-registry-server', 'data', 'models.prod.json'
)

// ---------------------------------------------------------------------------
// Engine-to-package mapping (addon packages only)
// ---------------------------------------------------------------------------
const ENGINE_MAP = {
  '@qvac/embed-llamacpp': 'qvac-lib-infer-llamacpp-embed',
  '@qvac/llm-llamacpp': 'qvac-lib-infer-llamacpp-llm',
  '@qvac/translation-nmtcpp': 'qvac-lib-infer-nmtcpp',
  '@qvac/tts-onnx': 'qvac-lib-infer-onnx-tts',
  '@qvac/transcription-whispercpp': 'qvac-lib-infer-whispercpp',
  '@qvac/translation-llamacpp': 'qvac-lib-infer-llamacpp-llm',
  '@qvac/ocr-onnx': 'ocr-onnx',
  '@qvac/diffusion-cpp': 'lib-infer-diffusion'
}

// Reverse map: package dir -> array of engines
const PACKAGE_ENGINES = {}
for (const [engine, pkgDir] of Object.entries(ENGINE_MAP)) {
  if (!PACKAGE_ENGINES[pkgDir]) PACKAGE_ENGINES[pkgDir] = []
  PACKAGE_ENGINES[pkgDir].push(engine)
}

// ---------------------------------------------------------------------------
// Packages that get the FULL model list in their NOTICE
// ---------------------------------------------------------------------------
const FULL_MODEL_LIST_PACKAGES = [
  'sdk',
  'qvac-lib-registry-server/client'
]

// ---------------------------------------------------------------------------
// vcpkg ports to skip (host-only / tool / internal)
// ---------------------------------------------------------------------------
const SKIP_VCPKG_PORTS = new Set([
  'vcpkg-cmake',
  'vcpkg-cmake-config',
  'vcpkg-tool-meson',
  'vcpkg-get-python-packages',
  'vcpkg-boost',
  'vcpkg-make',
  'qvac-lint-cpp',
  'qvac-lib-inference-addon-cpp'
])

// ---------------------------------------------------------------------------
// Python dependency file locations (relative to package dir)
// ---------------------------------------------------------------------------
const PYTHON_DEP_PATHS = {
  'qvac-lib-infer-llamacpp-embed': [
    'benchmarks/client/requirements.txt'
  ],
  'qvac-lib-infer-llamacpp-llm': [
    'benchmarks/client/requirements.txt'
  ],
  'qvac-lib-infer-nmtcpp': [
    'scripts/conversion_scripts/requirements.txt',
    'benchmarks/quality_eval/requirements.txt',
    'benchmarks/client/pyproject.toml'
  ],
  'qvac-lib-infer-onnx-tts': [
    'benchmarks/python-server/requirements-supertonic.txt',
    'benchmarks/python-server/requirements-chatterbox.txt',
    'benchmarks/client/requirements.txt',
    'benchmarks/client/pyproject.toml'
  ],
  'qvac-lib-infer-whispercpp': [
    'benchmarks/ci/requirements-conversion.txt',
    'benchmarks/client/pyproject.toml'
  ],
  'ocr-onnx': [
    'benchmarks/quality_eval/requirements.txt'
  ],
  'qvac-lib-infer-onnx-vad': [
    'benchmarks/client/pyproject.toml'
  ]
}

// ---------------------------------------------------------------------------
// Compiler/runtime libraries detected from vcpkg triplet flags.
// Key: regex pattern matched against VCPKG_CXX_FLAGS in triplet files.
// Value: attribution entry added to the C++ deps section.
// ---------------------------------------------------------------------------
const TRIPLET_COMPILER_LIBS = [
  {
    pattern: /-stdlib=libc\+\+/,
    entry: {
      name: 'libc++ (LLVM C++ Standard Library)',
      license: 'Apache-2.0 WITH LLVM-exception',
      url: 'https://github.com/llvm/llvm-project'
    }
  }
]

// ---------------------------------------------------------------------------
// Packages to skip entirely
// ---------------------------------------------------------------------------
const SKIP_PACKAGES = new Set(['docs'])

// ---------------------------------------------------------------------------
// Packages without their own package.json (skip JS scan)
// ---------------------------------------------------------------------------
const NO_JS_PACKAGES = new Set(['qvac-lint-cpp'])

// ---------------------------------------------------------------------------
// qvac vcpkg registry
// ---------------------------------------------------------------------------
const QVAC_VCPKG_REGISTRY_REPO = 'tetherto/qvac-registry-vcpkg'
const MS_VCPKG_REGISTRY_REPO = 'microsoft/vcpkg'

// ---------------------------------------------------------------------------
// License normalization (uses map from constants.js)
// ---------------------------------------------------------------------------
function normalizeLicenseId (license) {
  if (!license) return 'unknown'
  const raw = license.toLowerCase().trim()
  if (LICENSE_NORMALIZE_MAP[raw]) return LICENSE_NORMALIZE_MAP[raw]
  const stripped = raw.replace(/^the\s+/, '').replace(/\s+license$/i, '').trim()
  if (LICENSE_NORMALIZE_MAP[stripped]) return LICENSE_NORMALIZE_MAP[stripped]
  if (raw.includes(' and ') || raw.includes(' or ')) {
    const parts = raw.split(/\s+(?:and|or)\s+/i).map(p => {
      const n = LICENSE_NORMALIZE_MAP[p.trim()]
      return n || p.trim()
    })
    return parts.join(' AND ')
  }
  return raw
}

// ---------------------------------------------------------------------------
// Allowed license check (uses list from constants.js)
// ---------------------------------------------------------------------------
function isLicenseAllowed (license) {
  if (ALLOWED_LICENSES.length === 0) return true
  if (!license) return false
  const normalized = normalizeLicenseId(license)
  const parts = normalized.split(/\s+AND\s+/)
  return parts.every(part => ALLOWED_LICENSES.includes(part.trim()))
}

// ---------------------------------------------------------------------------
// npmrc template
// ---------------------------------------------------------------------------
function buildNpmrc () {
  const ghToken = process.env.GH_TOKEN || ''
  const npmToken = process.env.NPM_TOKEN || ''
  return [
    '@tetherto:registry=https://npm.pkg.github.com',
    '@qvac:registry=https://registry.npmjs.org',
    `//registry.npmjs.org/:_authToken=${npmToken}`,
    `//npm.pkg.github.com/:_authToken=${ghToken}`,
    ''
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Build the full list of scannable packages with their scan types
// ---------------------------------------------------------------------------
function getPackageList () {
  const fs = require('fs')
  const dirs = []

  const topLevel = fs.readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && !SKIP_PACKAGES.has(d.name))
    .map(d => d.name)

  for (const dir of topLevel) {
    const pkgJsonPath = path.join(PACKAGES_DIR, dir, 'package.json')
    if (!fs.existsSync(pkgJsonPath) && NO_JS_PACKAGES.has(dir)) continue

    if (dir === 'qvac-lib-registry-server') {
      for (const sub of ['client', 'shared']) {
        const subDir = `${dir}/${sub}`
        const subPkgPath = path.join(PACKAGES_DIR, subDir, 'package.json')
        if (!fs.existsSync(subPkgPath)) continue
        dirs.push(buildPackageEntry(subDir))
      }
      continue
    }

    dirs.push(buildPackageEntry(dir))
  }

  return dirs.sort((a, b) => a.npmName.localeCompare(b.npmName))
}

function buildPackageEntry (dir) {
  const fs = require('fs')
  const fullDir = path.join(PACKAGES_DIR, dir)
  const pkgJsonPath = path.join(fullDir, 'package.json')
  let npmName = dir
  let hasJsDeps = false

  if (fs.existsSync(pkgJsonPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'))
    npmName = pkg.name || dir
    hasJsDeps = !!(
      (pkg.dependencies && Object.keys(pkg.dependencies).length) ||
      (pkg.bundleDependencies && Object.keys(pkg.bundleDependencies).length)
    )
  }

  const scanTypes = []

  if (FULL_MODEL_LIST_PACKAGES.includes(dir)) {
    scanTypes.push('models-all')
  } else if (PACKAGE_ENGINES[dir]) {
    scanTypes.push('models-engine')
  }

  if (hasJsDeps && !NO_JS_PACKAGES.has(dir.split('/')[0])) {
    scanTypes.push('js')
  }

  if (PYTHON_DEP_PATHS[dir]) {
    scanTypes.push('python')
  }

  if (fs.existsSync(path.join(fullDir, 'vcpkg.json'))) {
    scanTypes.push('cpp')
  }

  return {
    dir,
    fullDir,
    npmName,
    scanTypes,
    engines: PACKAGE_ENGINES[dir] || [],
    pythonPaths: PYTHON_DEP_PATHS[dir] || []
  }
}

module.exports = {
  REPO_ROOT,
  PACKAGES_DIR,
  MODELS_JSON_PATH,
  COPYRIGHT_HOLDER,
  COPYRIGHT_YEAR,
  ENGINE_MAP,
  PACKAGE_ENGINES,
  FULL_MODEL_LIST_PACKAGES,
  SKIP_VCPKG_PORTS,
  TRIPLET_COMPILER_LIBS,
  PYTHON_DEP_PATHS,
  SKIP_PACKAGES,
  NO_JS_PACKAGES,
  QVAC_VCPKG_REGISTRY_REPO,
  MS_VCPKG_REGISTRY_REPO,
  LICENSE_NORMALIZE_MAP,
  normalizeLicenseId,
  ALLOWED_LICENSES,
  isLicenseAllowed,
  buildNpmrc,
  getPackageList,
  buildPackageEntry
}
