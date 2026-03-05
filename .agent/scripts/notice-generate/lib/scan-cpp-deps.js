'use strict'

const fs = require('fs')
const path = require('path')
const {
  SKIP_VCPKG_PORTS,
  TRIPLET_COMPILER_LIBS,
  QVAC_VCPKG_REGISTRY_REPO,
  MS_VCPKG_REGISTRY_REPO
} = require('./config')
const {
  fetchGHFileContent,
  fetchGHRepoLicense,
  sortByName,
  sleep
} = require('./utils')

const GH_DELAY_MS = 120

// ---------------------------------------------------------------------------
// Parse vcpkg.json — extract dependency names (skip features/overrides)
// ---------------------------------------------------------------------------
function parseVcpkgJson (pkgDir) {
  const vcpkgPath = path.join(pkgDir, 'vcpkg.json')
  if (!fs.existsSync(vcpkgPath)) return []

  const data = JSON.parse(fs.readFileSync(vcpkgPath, 'utf8'))
  const deps = data.dependencies || []
  const names = []

  for (const dep of deps) {
    const name = typeof dep === 'string' ? dep : dep.name
    if (name && !SKIP_VCPKG_PORTS.has(name)) {
      names.push(name)
    }
  }

  return [...new Set(names)]
}

// ---------------------------------------------------------------------------
// Parse vcpkg-configuration.json — determine which registry each dep comes from
// ---------------------------------------------------------------------------
function parseVcpkgConfig (pkgDir) {
  const configPath = path.join(pkgDir, 'vcpkg-configuration.json')
  if (!fs.existsSync(configPath)) return { defaultRegistry: null, registries: [], overlayPorts: [] }

  const data = JSON.parse(fs.readFileSync(configPath, 'utf8'))

  const defaultRegistry = data['default-registry'] || null
  const registries = data.registries || []
  const overlayPorts = data['overlay-ports'] || []

  return { defaultRegistry, registries, overlayPorts }
}

// ---------------------------------------------------------------------------
// Determine which registry/source provides each dependency
// ---------------------------------------------------------------------------
function classifyDeps (pkgDir) {
  const depNames = parseVcpkgJson(pkgDir)
  const config = parseVcpkgConfig(pkgDir)

  // Build a map of package -> specific registry
  const specificPackages = new Map()
  for (const reg of config.registries) {
    for (const pkg of (reg.packages || [])) {
      specificPackages.set(pkg, reg)
    }
  }

  // Build a map of overlay port names -> portfile path
  const overlayPortNames = new Map()
  for (const overlayDir of config.overlayPorts) {
    const absDir = path.join(pkgDir, overlayDir)
    // overlay-ports can be a directory of ports or a single port
    if (fs.existsSync(absDir) && fs.statSync(absDir).isDirectory()) {
      // Check if this IS a port dir (has portfile.cmake) or a dir of ports
      if (fs.existsSync(path.join(absDir, 'portfile.cmake'))) {
        // Single port — name is the directory name
        overlayPortNames.set(path.basename(overlayDir), absDir)
      } else {
        // Directory of ports
        const subs = fs.readdirSync(absDir, { withFileTypes: true })
        for (const sub of subs) {
          if (sub.isDirectory()) {
            const subPath = path.join(absDir, sub.name)
            if (fs.existsSync(path.join(subPath, 'portfile.cmake'))) {
              overlayPortNames.set(sub.name, subPath)
            }
          }
        }
      }
    }
  }

  const classified = []

  for (const name of depNames) {
    if (SKIP_VCPKG_PORTS.has(name)) continue

    // 1. Check overlay ports first (they override everything)
    if (overlayPortNames.has(name)) {
      classified.push({
        name,
        source: 'overlay',
        portfilePath: path.join(overlayPortNames.get(name), 'portfile.cmake')
      })
      continue
    }

    // 2. Check specific registries
    if (specificPackages.has(name)) {
      const reg = specificPackages.get(name)
      const isMicrosoft = (reg.repository || '').includes('microsoft/vcpkg')
      classified.push({
        name,
        source: isMicrosoft ? 'microsoft' : 'other-registry',
        registry: reg
      })
      continue
    }

    // 3. Default registry (qvac registry for most packages)
    if (config.defaultRegistry) {
      const isQvac = (config.defaultRegistry.repository || '').includes('qvac-registry-vcpkg')
      classified.push({
        name,
        source: isQvac ? 'qvac-registry' : 'default-registry',
        registry: config.defaultRegistry
      })
      continue
    }

    classified.push({ name, source: 'unknown' })
  }

  return classified
}

// ---------------------------------------------------------------------------
// Extract REPO and URL from portfile.cmake content
// ---------------------------------------------------------------------------
function extractPortfileInfo (content) {
  // vcpkg_from_github(... REPO org/name ...)
  const ghMatch = content.match(/vcpkg_from_github\s*\([^)]*REPO\s+([^\s)]+)/)
  if (ghMatch) {
    return { type: 'github', repo: ghMatch[1] }
  }

  // vcpkg_from_git(... URL git@github.com:org/repo.git ...)
  const gitSshMatch = content.match(/vcpkg_from_git\s*\([^)]*URL\s+git@github\.com:([^.\s)]+)/)
  if (gitSshMatch) {
    return { type: 'github', repo: gitSshMatch[1] }
  }

  // vcpkg_from_git(... URL https://github.com/org/repo ...)
  const gitHttpsMatch = content.match(/vcpkg_from_git\s*\([^)]*URL\s+https:\/\/github\.com\/([^\s.)]+)/)
  if (gitHttpsMatch) {
    return { type: 'github', repo: gitHttpsMatch[1] }
  }

  return null
}

// ---------------------------------------------------------------------------
// Resolve a single dependency to its attribution info
// ---------------------------------------------------------------------------
async function resolveDep (dep, log) {
  if (dep.source === 'overlay') {
    // Read local portfile
    try {
      const content = fs.readFileSync(dep.portfilePath, 'utf8')
      const info = extractPortfileInfo(content)
      if (info && info.type === 'github') {
        const license = await fetchGHRepoLicense(info.repo)
        return {
          name: dep.name,
          license: license || 'Unknown',
          url: `https://github.com/${info.repo}`
        }
      }
    } catch (err) {
      log.push(`[C++] Failed to read overlay portfile for ${dep.name}: ${err.message}`)
    }
    return { name: dep.name, license: 'Unknown', url: '' }
  }

  if (dep.source === 'qvac-registry') {
    // Fetch portfile from qvac registry via GitHub API
    const baseline = dep.registry.baseline
    const portfilePath = `ports/${dep.name}/portfile.cmake`
    try {
      await sleep(GH_DELAY_MS)
      const content = await fetchGHFileContent(QVAC_VCPKG_REGISTRY_REPO, portfilePath, baseline)
      const info = extractPortfileInfo(content)
      if (info && info.type === 'github') {
        await sleep(GH_DELAY_MS)
        const license = await fetchGHRepoLicense(info.repo)
        return {
          name: dep.name,
          license: license || 'Unknown',
          url: `https://github.com/${info.repo}`
        }
      }
      log.push(`[C++] No vcpkg_from_github/git found in portfile for ${dep.name} (qvac registry)`)
    } catch (err) {
      log.push(`[C++] Failed to fetch qvac registry portfile for ${dep.name} @ ${baseline.slice(0, 8)}: ${err.message}`)
    }
    return { name: dep.name, license: 'Unknown', url: '' }
  }

  if (dep.source === 'microsoft') {
    // Fetch portfile from microsoft/vcpkg
    const baseline = dep.registry.baseline
    const portfilePath = `ports/${dep.name}/portfile.cmake`
    try {
      await sleep(GH_DELAY_MS)
      const content = await fetchGHFileContent(MS_VCPKG_REGISTRY_REPO, portfilePath, baseline)
      const info = extractPortfileInfo(content)
      if (info && info.type === 'github') {
        await sleep(GH_DELAY_MS)
        const license = await fetchGHRepoLicense(info.repo)
        return {
          name: dep.name,
          license: license || 'Unknown',
          url: `https://github.com/${info.repo}`
        }
      }
      // If no vcpkg_from_github found, try to get license from the port's vcpkg.json
      await sleep(GH_DELAY_MS)
      try {
        const vcpkgJsonContent = await fetchGHFileContent(
          MS_VCPKG_REGISTRY_REPO, `ports/${dep.name}/vcpkg.json`, baseline
        )
        const vcpkgData = JSON.parse(vcpkgJsonContent)
        const homepage = vcpkgData.homepage || ''
        const license = vcpkgData.license || 'Unknown'
        return { name: dep.name, license, url: homepage }
      } catch (innerErr) {
        log.push(`[C++] No vcpkg_from_github/git in portfile and vcpkg.json fallback failed for ${dep.name}: ${innerErr.message}`)
      }
    } catch (err) {
      log.push(`[C++] Failed to fetch microsoft/vcpkg portfile for ${dep.name} @ ${baseline.slice(0, 8)}: ${err.message}`)
    }
    return { name: dep.name, license: 'Unknown', url: '' }
  }

  log.push(`[C++] Unknown source for ${dep.name}`)
  return { name: dep.name, license: 'Unknown', url: '' }
}

// ---------------------------------------------------------------------------
// Scan vcpkg overlay triplet files for compiler/runtime library flags
// (e.g. -stdlib=libc++ → attribute libc++)
// ---------------------------------------------------------------------------
function detectCompilerLibs (pkgDir, log) {
  const results = []
  const seen = new Set()

  const tripletsDir = path.join(pkgDir, 'vcpkg', 'triplets')
  if (!fs.existsSync(tripletsDir)) return results

  const files = fs.readdirSync(tripletsDir).filter(f => f.endsWith('.cmake'))
  for (const file of files) {
    const content = fs.readFileSync(path.join(tripletsDir, file), 'utf8')
    for (const { pattern, entry } of TRIPLET_COMPILER_LIBS) {
      if (pattern.test(content) && !seen.has(entry.name)) {
        seen.add(entry.name)
        results.push({ ...entry })
        log.push(`[C++] Detected compiler library "${entry.name}" from triplet ${file}`)
      }
    }
  }

  return results
}

// ---------------------------------------------------------------------------
// Scan all C++ dependencies for a package
// Returns: [{ name, license, url }]
// ---------------------------------------------------------------------------
async function scanCppDeps (pkgDir, log) {
  const vcpkgPath = path.join(pkgDir, 'vcpkg.json')
  if (!fs.existsSync(vcpkgPath)) {
    log.push(`[C++] No vcpkg.json in ${pkgDir}, skipping`)
    return []
  }

  const classified = classifyDeps(pkgDir)
  if (classified.length === 0) return []

  console.log(`  Resolving ${classified.length} C++ dependencies...`)
  const results = []

  for (const dep of classified) {
    process.stderr.write(`    ${dep.name} (${dep.source})...`)
    const resolved = await resolveDep(dep, log)
    results.push(resolved)
    process.stderr.write(` ${resolved.license}\n`)
  }

  const compilerLibs = detectCompilerLibs(pkgDir, log)
  for (const lib of compilerLibs) {
    process.stderr.write(`    ${lib.name} (compiler-lib)... ${lib.license}\n`)
    results.push(lib)
  }

  return results.sort(sortByName)
}

module.exports = { scanCppDeps, classifyDeps, extractPortfileInfo }
