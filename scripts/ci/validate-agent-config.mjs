#!/usr/bin/env node

import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const skillRoot = resolve(repoRoot, '.agents/skills')
const claudeRoot = resolve(repoRoot, '.claude/skills')
const packageSkillRoot = resolve(repoRoot, 'packages/ocr-ggml/.agent/skills')
const checkClaudeMirror = process.argv.includes('--claude-mirror')
const errors = []

const walkFiles = (root) => {
  const files = []

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name)
    if (entry.isDirectory()) files.push(...walkFiles(path))
    else if (entry.isFile()) files.push(path)
  }

  return files
}

const skillDirectories = readdirSync(skillRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => resolve(skillRoot, entry.name))
  .filter((path) => existsSync(resolve(path, 'SKILL.md')))
  .sort()
const skillNames = new Set(skillDirectories.map((directory) => relative(skillRoot, directory)))

for (const entry of readdirSync(packageSkillRoot, { withFileTypes: true })) {
  if (
    entry.isDirectory() &&
    existsSync(resolve(packageSkillRoot, entry.name, 'SKILL.md')) &&
    skillNames.has(entry.name)
  ) {
    errors.push(`${entry.name}: duplicated in repository and OCR-specific skill catalogs`)
  }
}

for (const skillDirectory of skillDirectories) {
  const skillName = relative(skillRoot, skillDirectory)
  const skillFile = resolve(skillDirectory, 'SKILL.md')
  const content = readFileSync(skillFile, 'utf8')
  const declaredName = content.match(/^name:\s*(.+)$/m)?.[1]?.trim()

  if (declaredName !== skillName) {
    errors.push(`${relative(repoRoot, skillFile)}: name must be ${skillName}`)
  }

  if (!/^description:\s*\S+/m.test(content)) {
    errors.push(`${relative(repoRoot, skillFile)}: missing description`)
  }

  if (content.includes('.cursor/skills')) {
    errors.push(`${relative(repoRoot, skillFile)}: references removed .cursor/skills`)
  }

  if (/^disable-model-invocation:\s*true\s*$/m.test(content)) {
    const metadataFile = resolve(skillDirectory, 'agents/openai.yaml')
    const metadata = existsSync(metadataFile) ? readFileSync(metadataFile, 'utf8') : ''
    if (!/^\s*allow_implicit_invocation:\s*false\s*$/m.test(metadata)) {
      errors.push(`${skillName}: manual-only skill lacks Codex invocation policy`)
    }
  }

  if (checkClaudeMirror && skillName !== 'setup') {
    const mirrorDirectory = resolve(claudeRoot, skillName)
    if (!existsSync(mirrorDirectory)) {
      errors.push(`${relative(repoRoot, mirrorDirectory)}: missing Claude compatibility entry`)
    } else if (lstatSync(mirrorDirectory).isSymbolicLink()) {
      if (realpathSync(mirrorDirectory) !== realpathSync(skillDirectory)) {
        errors.push(`${relative(repoRoot, mirrorDirectory)}: points outside the canonical skill tree`)
      }
    } else {
      for (const sourceFile of walkFiles(skillDirectory)) {
        const sourceRelativePath = relative(skillDirectory, sourceFile)
        const mirrorFile = resolve(mirrorDirectory, sourceRelativePath)
        if (!existsSync(mirrorFile)) {
          errors.push(`${relative(repoRoot, mirrorFile)}: missing from Claude mirror`)
        } else if (readFileSync(sourceFile).compare(readFileSync(mirrorFile)) !== 0) {
          errors.push(`${relative(repoRoot, mirrorFile)}: differs from canonical skill`)
        }
      }
    }
  }
}

for (const markdownFile of walkFiles(skillRoot).filter((path) => path.endsWith('.md'))) {
  const content = readFileSync(markdownFile, 'utf8')
  const prose = content.replace(/```[\s\S]*?```/g, '')
  const links = prose.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)

  for (const [, rawTarget] of links) {
    const target = rawTarget.trim().replace(/^<|>$/g, '').split('#', 1)[0]
    if (
      !target ||
      /^(?:[a-z]+:|#)/i.test(target) ||
      /^(?:url|\.\.\.|deep link)$/i.test(target) ||
      /[<{\[]/.test(target)
    ) continue

    const resolvedTarget = resolve(dirname(markdownFile), target)
    if (!existsSync(resolvedTarget)) {
      errors.push(`${relative(repoRoot, markdownFile)}: broken link ${rawTarget}`)
    }
  }
}

const bootstrap = resolve(claudeRoot, 'setup/SKILL.md')
const canonicalBootstrap = resolve(skillRoot, 'setup/SKILL.md')
if (!existsSync(bootstrap)) {
  errors.push('.claude/skills/setup/SKILL.md: missing Claude bootstrap skill')
} else if (readFileSync(bootstrap).compare(readFileSync(canonicalBootstrap)) !== 0) {
  errors.push('.claude/skills/setup/SKILL.md: differs from canonical setup skill')
}

const cursorRoot = resolve(repoRoot, '.cursor/skills')
if (existsSync(cursorRoot) && lstatSync(cursorRoot).isDirectory()) {
  for (const skillDirectory of skillDirectories) {
    const skillName = relative(skillRoot, skillDirectory)
    if (existsSync(resolve(cursorRoot, skillName))) {
      errors.push(`.cursor/skills/${skillName}: duplicates a canonical repository skill`)
    }
  }
}

if (errors.length) {
  console.error(errors.map((error) => `- ${error}`).join('\n'))
  process.exitCode = 1
} else {
  const manualCount = skillDirectories.filter((directory) =>
    /^disable-model-invocation:\s*true\s*$/m.test(readFileSync(resolve(directory, 'SKILL.md'), 'utf8')),
  ).length
  console.log(`Validated ${skillDirectories.length} skills (${manualCount} manual-only).`)
}
