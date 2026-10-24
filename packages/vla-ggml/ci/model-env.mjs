// Points the tests' model variables at the manifest's destinations, unless already set or skipped on this host.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PKG = fileURLToPath(new URL('..', import.meta.url))

export function modelEnv(
  vars,
  { env = process.env, pkg = PKG, host = `${process.platform}-${process.arch}`, manifest } = {}
) {
  const models = (
    manifest ?? JSON.parse(readFileSync(join(pkg, 'test/integration/models.manifest.json'), 'utf8'))
  ).models
  const out = {}
  for (const [name, model] of Object.entries(vars)) {
    const m = models[model]
    if (!m) throw new Error(`${model} is not in the model manifest`)
    if (env[name] !== undefined) out[name] = env[name]
    else if (!m.skip?.includes(host)) out[name] = join(pkg, m.dest)
  }
  return out
}
