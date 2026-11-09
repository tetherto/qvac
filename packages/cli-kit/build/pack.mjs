// Pack the npm archive from a clean copy of the publication inputs, so no local node_modules leaks in.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

// npm.cmd is a batch file, which Windows only runs through a shell
const windows = process.platform === 'win32'

// check: the product's publish gate, run from its root before anything is copied
export function pack({ root, destination = root, check = 'scripts/check-publish-ready.mjs' }) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-distribution-'))
  const npm = (args) =>
    execFileSync(windows ? 'npm.cmd' : 'npm', args, {
      cwd: stage,
      stdio: 'inherit',
      shell: windows
    })

  try {
    execFileSync(process.execPath, [check], { cwd: root, stdio: 'inherit' })
    // These are the manifest's publication inputs. npm applies its files allowlist
    // when creating the archive.
    for (const name of [
      'package.json',
      'npm-shrinkwrap.json',
      'dist',
      'scripts',
      'patches',
      'skills',
      'docs',
      'README.md',
      'LICENSE',
      'NOTICE'
    ]) {
      const source = path.join(root, name)
      if (!fs.existsSync(source)) continue
      fs.cpSync(source, path.join(stage, name), {
        recursive: true,
        mode: fs.constants.COPYFILE_FICLONE,
        filter: (file) => !file.split(path.sep).includes('node_modules')
      })
    }
    fs.mkdirSync(destination, { recursive: true })
    npm(['pack', '--pack-destination', destination])
  } finally {
    fs.rmSync(stage, { recursive: true, force: true })
  }
}
