'use strict'

function escapeRegExp (value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function extractVersionSection (changelog, version) {
  const lines = changelog.split(/\r?\n/)
  const headingPattern = new RegExp(`^## \\[${escapeRegExp(version)}\\] - \\d{4}-\\d{2}-\\d{2}\\s*$`)

  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (headingPattern.test(lines[i])) {
      start = i
      break
    }
  }

  if (start === -1) {
    return { found: false, body: '' }
  }

  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## \[/.test(lines[i])) {
      end = i
      break
    }
  }

  return {
    found: true,
    body: lines.slice(start + 1, end).join('\n').trim()
  }
}

function getChangedPath (entry) {
  return typeof entry === 'string' ? entry : entry.filename
}

function decodeContent (resp) {
  if (!resp || Array.isArray(resp.data)) return null
  const { content, encoding } = resp.data
  if (!content) return null
  if (encoding === 'base64') {
    return Buffer.from(content, 'base64').toString('utf8')
  }
  return content
}

async function validateReleaseNotesOnVersionBump ({
  files,
  baseSha,
  headSha,
  readJsonAtRef,
  readTextAtRef,
  log = () => {}
}) {
  const changedPaths = files.map(getChangedPath)
  const packageJsonFiles = changedPaths
    .filter((filename) => filename === 'package.json' || filename.endsWith('/package.json'))

  if (packageJsonFiles.length === 0) {
    log('No package.json files changed; no release notes required.')
    return []
  }

  const changedFileSet = new Set(changedPaths)
  const failures = []

  for (const pkgPath of packageJsonFiles) {
    const baseJson = await readJsonAtRef(pkgPath, baseSha)
    const headJson = await readJsonAtRef(pkgPath, headSha)

    if (!baseJson || !headJson) {
      log(`Skipping ${pkgPath}: unable to read base/head contents.`)
      continue
    }

    const baseVer = baseJson.version
    const headVer = headJson.version

    if (!headVer) {
      log(`Skipping ${pkgPath}: no "version" field found in head.`)
      continue
    }

    if (baseVer === headVer) {
      log(`No version bump detected for ${pkgPath} (version stays ${headVer}).`)
      continue
    }

    const pkgDir = pkgPath.includes('/') ? pkgPath.slice(0, pkgPath.lastIndexOf('/')) : ''
    const changelogPath = pkgDir ? `${pkgDir}/CHANGELOG.md` : 'CHANGELOG.md'

    log(
      `Detected version bump in ${pkgPath}: ${baseVer ?? '<missing>'} -> ${headVer}. ` +
      `Validating changelog section in: ${changelogPath}`
    )

    if (!changedFileSet.has(changelogPath)) {
      failures.push(
        `- ${pkgPath} bumped ${baseVer ?? '<missing>'} -> ${headVer} but \`${changelogPath}\` was not changed.\n` +
        `  Add a changelog entry with heading: \`## [${headVer}] - YYYY-MM-DD\``
      )
      continue
    }

    const changelog = await readTextAtRef(changelogPath, headSha)
    if (!changelog) {
      failures.push(
        `- ${pkgPath} bumped ${baseVer ?? '<missing>'} -> ${headVer} but \`${changelogPath}\` could not be read from PR head.`
      )
      continue
    }

    const section = extractVersionSection(changelog, headVer)
    if (!section.found) {
      failures.push(
        `- ${pkgPath} bumped ${baseVer ?? '<missing>'} -> ${headVer} but \`${changelogPath}\` has no section heading \`## [${headVer}] - YYYY-MM-DD\`.`
      )
      continue
    }

    if (!section.body) {
      failures.push(
        `- ${pkgPath} bumped ${baseVer ?? '<missing>'} -> ${headVer} but changelog section \`## [${headVer}] - YYYY-MM-DD\` is empty.`
      )
    }
  }

  return failures
}

function formatFailures (failures) {
  return (
    'Release notes check failed.\n\n' +
    'One or more package.json version bumps were detected without matching changelog release notes:\n\n' +
    failures.join('\n\n')
  )
}

module.exports = {
  decodeContent,
  extractVersionSection,
  formatFailures,
  validateReleaseNotesOnVersionBump
}
