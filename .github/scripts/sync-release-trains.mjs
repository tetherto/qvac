#!/usr/bin/env node
/**
 * Regenerate nx.json's `release` block from .github/release-trains.json.
 *
 * After editing the catalog:
 *   node .github/scripts/sync-release-trains.mjs
 *   node --test .github/scripts/test/release-trains.test.mjs
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { NX_JSON, loadCatalog, renderNxJson, repoRoot, trainNames } from './lib/release-trains.mjs'

const catalog = loadCatalog()
writeFileSync(join(repoRoot, NX_JSON), renderNxJson(catalog), 'utf8')
console.log(`wrote ${NX_JSON} release block for train(s): ${trainNames(catalog).join(', ')}`)
