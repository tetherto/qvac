import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { resolveFrom } from '../../dist/lib/runtime/config-import.js'

test('config resolution uses native import exports relative to each config', async (t) => {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-resolution-')))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  for (const project of ['one', 'two with spaces']) {
    const dir = path.join(temp, project)
    const dep = path.join(dir, 'node_modules/conditional-plugin')
    fs.mkdirSync(dep, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        type: 'module',
        imports: { '#local-plugin': './local.mjs' }
      })
    )
    fs.writeFileSync(
      path.join(dep, 'package.json'),
      JSON.stringify({
        type: 'module',
        exports: { '.': { import: './import.mjs', require: './require.cjs' } }
      })
    )
    // Resolution must not execute the selected plugin.
    for (const file of ['import.mjs', 'require.cjs']) {
      fs.writeFileSync(path.join(dep, file), 'throw new Error("must not execute")')
    }
    fs.writeFileSync(path.join(dir, 'local.mjs'), 'throw new Error("must not execute")')
    const parent = pathToFileURL(path.join(dir, 'qvac.config.js')).href
    assert.equal(
      await resolveFrom('conditional-plugin', parent),
      pathToFileURL(path.join(dep, 'import.mjs')).href
    )
    assert.equal(
      await resolveFrom('#local-plugin', parent),
      pathToFileURL(path.join(dir, 'local.mjs')).href
    )
    assert.equal(
      await resolveFrom('./local.mjs', parent),
      pathToFileURL(path.join(dir, 'local.mjs')).href
    )
    await assert.rejects(resolveFrom('missing-plugin', parent), { code: 'ERR_MODULE_NOT_FOUND' })
    await assert.rejects(resolveFrom('conditional-plugin/private', parent), {
      code: 'ERR_PACKAGE_PATH_NOT_EXPORTED'
    })
  }
})
