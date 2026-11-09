// Published CLI installs need the generated npm shrinkwrap: npm ignores an
// installed dependency's overrides. Keep its direct specs aligned with the
// manifest; npm version handles release-version metadata separately.
import fs from 'node:fs'
import path from 'node:path'

// What keeps the product at root from publishing: the shrinkwrap's state, then each of the
// product's own checks of its manifest. Nothing wrong gives an empty list.
export function checkPublishReady({ root, checks = [] }) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const errors = []

  const lockPath = path.join(root, 'npm-shrinkwrap.json')
  if (!fs.existsSync(lockPath)) {
    errors.push('npm-shrinkwrap.json is missing; regenerate the npm distribution lock')
  } else {
    const packages = JSON.parse(fs.readFileSync(lockPath, 'utf8')).packages || {}
    const locked = packages['']
    // a bundled dependency is packed from the workspace, so npm never resolved it into the lock
    const bundled = new Set(pkg.bundleDependencies)
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const wanted = pkg[field] || {}
      const actual = locked?.[field] || {}
      for (const name of new Set([...Object.keys(wanted), ...Object.keys(actual)])) {
        if (!bundled.has(name) && wanted[name] !== actual[name]) {
          errors.push(`npm-shrinkwrap.json ${field}["${name}"] differs from package.json`)
        }
      }
    }
    // npm does not record overrides in the lock, so check their effect: every
    // locked copy of an overridden package must be the version the override names.
    for (const [name, spec] of Object.entries(pkg.overrides || {})) {
      if (typeof spec !== 'string') continue
      const version = spec.startsWith('$') ? pkg.dependencies?.[spec.slice(1)] : spec
      for (const [location, entry] of Object.entries(packages)) {
        if (location.endsWith('node_modules/' + name) && entry.version !== version) {
          errors.push(
            `npm-shrinkwrap.json ${location} is ${entry.version}; overrides want ${version}`
          )
        }
      }
    }
  }

  for (const check of checks) {
    errors.push(...check(pkg))
  }

  return errors
}
