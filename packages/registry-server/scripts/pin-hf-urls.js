'use strict'

const path = require('path')
const fs = require('fs').promises
const { listCommits } = require('@huggingface/hub')

const logger = require('../lib/logger')

const HF_URL_PATTERN = /https?:\/\/huggingface\.co\/([^/]+)\/([^/]+)\/(blob|resolve)\/(main|master)(\/.+)?/i

function extractRepoInfo (url) {
  const match = url.trim().match(HF_URL_PATTERN)
  if (!match) return null

  const [, org, repo, action, branch, filePath] = match
  return {
    org,
    repo,
    repoId: `${org}/${repo}`,
    action,
    branch,
    filePath: filePath || '',
    originalUrl: url.trim()
  }
}

function buildPinnedUrl (repoInfo, commitSha) {
  const { org, repo, action, filePath } = repoInfo
  return `https://huggingface.co/${org}/${repo}/${action}/${commitSha}${filePath}`
}

async function fetchCommitHash (repoId) {
  try {
    const commits = listCommits({ repo: repoId, revision: 'main', batchSize: 1 })
    const firstCommit = await commits.next()
    if (firstCommit.done) {
      throw new Error(`No commits found for ${repoId}`)
    }
    return firstCommit.value.oid
  } catch (err) {
    logger.error(`Failed to fetch commit for ${repoId}:`, err.message)
    throw err
  }
}

async function pinHfUrls (filePath, dryRun = false) {
  const resolvedPath = path.resolve(filePath)
  logger.info(`Reading models from: ${resolvedPath}`)

  const content = await fs.readFile(resolvedPath, 'utf8')
  const models = JSON.parse(content)

  if (!Array.isArray(models)) {
    throw new Error('models.prod.json must contain an array of model entries')
  }

  logger.info(`Found ${models.length} model entries`)

  const repoMap = new Map()
  const updates = []

  for (let i = 0; i < models.length; i++) {
    const model = models[i]
    if (!model.source || typeof model.source !== 'string') {
      continue
    }

    const repoInfo = extractRepoInfo(model.source)
    if (!repoInfo) {
      continue
    }

    if (!repoMap.has(repoInfo.repoId)) {
      repoMap.set(repoInfo.repoId, {
        repoId: repoInfo.repoId,
        entries: []
      })
    }

    repoMap.get(repoInfo.repoId).entries.push({
      index: i,
      repoInfo
    })
  }

  logger.info(`Found ${repoMap.size} unique HuggingFace repositories to process`)

  if (dryRun) {
    logger.info('DRY RUN MODE: No changes will be made')
  }

  const commitCache = new Map()

  for (const [repoId, repoData] of repoMap) {
    let commitSha
    try {
      if (!commitCache.has(repoId)) {
        logger.info(`Fetching commit hash for ${repoId}...`)
        commitSha = await fetchCommitHash(repoId)
        commitCache.set(repoId, commitSha)
        logger.info(`  → ${commitSha}`)
      } else {
        commitSha = commitCache.get(repoId)
      }

      for (const entry of repoData.entries) {
        const { index, repoInfo } = entry
        const newUrl = buildPinnedUrl(repoInfo, commitSha)
        const oldUrl = models[index].source

        if (oldUrl !== newUrl) {
          updates.push({
            index,
            repoId,
            oldUrl,
            newUrl
          })

          if (!dryRun) {
            models[index].source = newUrl
          }
        }
      }
    } catch (err) {
      logger.error(`Error processing ${repoId}:`, err.message)
      for (const entry of repoData.entries) {
        updates.push({
          index: entry.index,
          repoId,
          oldUrl: models[entry.index].source,
          newUrl: null,
          error: err.message
        })
      }
    }
  }

  logger.info('\n=== Update Summary ===')
  logger.info(`Repositories processed: ${repoMap.size}`)
  logger.info(`URLs to update: ${updates.filter(u => u.newUrl).length}`)
  logger.info(`Errors: ${updates.filter(u => u.error).length}`)

  if (updates.length > 0) {
    logger.info('\nUpdates:')
    for (const update of updates) {
      if (update.error) {
        logger.error(`  [${update.repoId}] ERROR: ${update.error}`)
        logger.error(`    ${update.oldUrl}`)
      } else {
        logger.info(`  [${update.repoId}]`)
        logger.info(`    ${update.oldUrl}`)
        logger.info(`    → ${update.newUrl}`)
      }
    }
  }

  if (!dryRun && updates.some(u => u.newUrl)) {
    logger.info(`\nWriting updated models to ${resolvedPath}...`)
    const updatedContent = JSON.stringify(models, null, 2) + '\n'
    await fs.writeFile(resolvedPath, updatedContent, 'utf8')
    logger.info('Done!')
  } else if (dryRun) {
    logger.info('\nRun without --dry-run to apply changes')
  } else {
    logger.info('\nNo changes needed')
  }
}

async function main () {
  const args = process.argv.slice(2)
  const fileArg = args.find(arg => arg.startsWith('--file='))
  const filePath = fileArg ? fileArg.split('=')[1] : './data/models.prod.json'
  const dryRun = args.includes('--dry-run')

  try {
    await pinHfUrls(filePath, dryRun)
  } catch (err) {
    logger.error('Fatal error:', err)
    process.exit(1)
  }
}

if (require.main === module) {
  main()
}

module.exports = { pinHfUrls }
