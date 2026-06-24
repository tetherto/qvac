'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const { exec, sortByName, fetchPyPILicense, fetchGHRepoLicense } = require('./utils')

// ---------------------------------------------------------------------------
// Parse requirements.txt — extract package names (ignore versions/comments)
// ---------------------------------------------------------------------------
function parseRequirementsTxt (filePath) {
  if (!fs.existsSync(filePath)) return []
  const lines = fs.readFileSync(filePath, 'utf8').split('\n')
  const pkgs = []
  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('-')) continue
    const match = line.match(/^([A-Za-z0-9_.-]+)/)
    if (match) {
      pkgs.push(match[1].toLowerCase().replace(/_/g, '-'))
    }
  }
  return pkgs
}

// ---------------------------------------------------------------------------
// Parse pyproject.toml — minimal parser for dependencies list
// ---------------------------------------------------------------------------
function parsePyprojectToml (filePath) {
  if (!fs.existsSync(filePath)) return []
  const content = fs.readFileSync(filePath, 'utf8')
  const pkgs = []

  // PEP 621: dependencies = ["pkg>=1.0", ...]
  const pep621Match = content.match(/\bdependencies\s*=\s*\[([\s\S]*?)\]/)
  if (pep621Match) {
    const items = pep621Match[1].match(/"([^"]+)"/g) || []
    for (const item of items) {
      const clean = item.replace(/"/g, '')
      const match = clean.match(/^([A-Za-z0-9_.-]+)/)
      if (match) {
        const name = match[1].toLowerCase().replace(/_/g, '-')
        if (name !== 'python') pkgs.push(name)
      }
    }
    return [...new Set(pkgs)]
  }

  // Poetry: [tool.poetry.dependencies]
  const poetrySection = content.match(
    /\[tool\.poetry\.dependencies\]([\s\S]*?)(?:\n\[|\n$)/
  )
  if (poetrySection) {
    const lines = poetrySection[1].split('\n')
    for (const line of lines) {
      const match = line.match(/^([A-Za-z0-9_.-]+)\s*=/)
      if (match) {
        const name = match[1].toLowerCase().replace(/_/g, '-')
        if (name !== 'python') pkgs.push(name)
      }
    }
  }

  return [...new Set(pkgs)]
}

// ---------------------------------------------------------------------------
// Collect all unique Python dep names from a package's requirement files
// ---------------------------------------------------------------------------
function collectPythonPackageNames (pkgDir, pythonPaths, log) {
  const allPkgs = new Set()
  for (const relPath of pythonPaths) {
    const absPath = path.join(pkgDir, relPath)
    if (!fs.existsSync(absPath)) {
      log.push(`[Python] File not found: ${absPath}`)
      continue
    }
    const pkgs = relPath.endsWith('.toml')
      ? parsePyprojectToml(absPath)
      : parseRequirementsTxt(absPath)
    for (const p of pkgs) allPkgs.add(p)
  }
  return [...allPkgs]
}

// ---------------------------------------------------------------------------
// Create temp virtualenv, install packages, run pip-licenses
// ---------------------------------------------------------------------------
function runPipLicenses (packageNames, log) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notice-py-'))
  const venvDir = path.join(tmpDir, 'venv')

  const execOpts = { maxBuffer: 50 * 1024 * 1024 } // 50 MB buffer
  const failedPackages = new Set()

  try {
    // Create virtualenv
    console.log(`  Creating temp virtualenv...`)
    exec(`python3 -m venv ${venvDir}`, { stdio: 'ignore', ...execOpts })

    const pip = path.join(venvDir, 'bin', 'pip')
    const python = path.join(venvDir, 'bin', 'python')

    // Install the packages (ignore failures for packages that can't install)
    console.log(`  Installing ${packageNames.length} Python packages...`)
    const installList = packageNames.join(' ')
    try {
      exec(`${pip} install --quiet --cache-dir /tmp/notice-pip-cache ${installList}`, { stdio: 'ignore', ...execOpts })
    } catch (err) {
      // Some packages may fail (e.g. torch on some platforms)
      // Try installing one by one to get as many as possible
      log.push(`[Python] Bulk install failed, falling back to one-by-one`)
      for (const pkg of packageNames) {
        try {
          exec(`${pip} install --quiet --cache-dir /tmp/notice-pip-cache ${pkg}`, { stdio: 'ignore', ...execOpts })
        } catch {
          failedPackages.add(pkg)
        }
      }
    }

    // Install pip-licenses
    exec(`${pip} install --quiet pip-licenses`, { stdio: 'ignore', ...execOpts })

    // Run pip-licenses (no --with-license-file to keep output small)
    const rawJson = exec(
      `${python} -m piplicenses --format=json --with-urls`,
      { cwd: tmpDir, ...execOpts }
    )

    return { results: JSON.parse(rawJson), failedPackages }
  } catch (err) {
    log.push(`[Python] pip-licenses failed: ${err.message}`)
    return { results: [], failedPackages }
  } finally {
    // Clean up temp dir
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Scan Python dependencies for a package
// pythonPaths: array of relative paths to requirements/pyproject files
// Returns: [{ name, license, url }]
// ---------------------------------------------------------------------------
async function scanPythonDeps (pkgDir, pythonPaths, log) {
  const packageNames = collectPythonPackageNames(pkgDir, pythonPaths, log)
  if (packageNames.length === 0) return []

  console.log(`  Found ${packageNames.length} Python packages to scan...`)

  const { results, failedPackages } = runPipLicenses(packageNames, log)
  if (results.length === 0 && failedPackages.size === 0) return []

  // Map pip-licenses output to our format
  // pip-licenses returns: { Name, Version, License, URL }
  const mapped = []
  const installedNames = new Set(results.map(r => r.Name.toLowerCase().replace(/_/g, '-')))

  for (const r of results) {
    const name = r.Name.toLowerCase().replace(/_/g, '-')
    // Only include packages we actually requested (skip transitive deps of pip-licenses itself)
    if (!packageNames.includes(name)) continue

    let license = r.License || 'Unknown'
    let url = r.URL || r.Home || `https://pypi.org/project/${r.Name}/`

    // PyPI API fallback when pip-licenses returns UNKNOWN
    if (license === 'UNKNOWN' || license === 'Unknown') {
      const pypi = await fetchPyPILicense(name)
      if (pypi.license) {
        license = pypi.license
      } else {
        log.push(`[Python] Could not determine license for ${name}`)
      }
      if (pypi.url) url = pypi.url
    }

    mapped.push({ name, license, url })
  }

  // For packages that didn't install, try PyPI API directly
  for (const pkg of packageNames) {
    if (!installedNames.has(pkg)) {
      const pypi = await fetchPyPILicense(pkg)
      if (pypi.license) {
        mapped.push({ name: pkg, license: pypi.license, url: pypi.url || `https://pypi.org/project/${pkg}/` })
        if (failedPackages.has(pkg)) {
          log.push(`[Python] ${pkg}: pip install failed (likely Python version constraint), license resolved via PyPI`)
        }
      } else {
        log.push(`[Python] ${pkg}: pip install failed and not found on PyPI`)
        mapped.push({ name: pkg, license: 'Unknown', url: `https://pypi.org/project/${pkg}/` })
      }
    }
  }

  return mapped.sort(sortByName)
}

module.exports = { scanPythonDeps, parseRequirementsTxt, parsePyprojectToml }
