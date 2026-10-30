#!/usr/bin/env node
// The MegaLoc converter's maths, in a throwaway venv with numpy pinned by hash, as main's test-converter job ran it.

import { mkdtempSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = fileURLToPath(new URL('..', import.meta.url))
const NUMPY =
  'numpy==2.4.4 --hash=sha256:81f4a14bee47aec54f883e0cad2d73986640c1590eb9bfaaba7ad17394481e6e'

const dir = mkdtempSync(join(tmpdir(), 'megaloc-'))
const python = join(dir, 'venv/bin/python')
const sh = (cmd, args) => execFileSync(cmd, args, { cwd: PKG, stdio: 'inherit' })
writeFileSync(join(dir, 'requirements.txt'), `${NUMPY}\n`)
sh('python3', ['-m', 'venv', join(dir, 'venv')])
sh(python, [
  '-m',
  'pip',
  'install',
  '--no-cache-dir',
  '--only-binary=:all:',
  '--require-hashes',
  '-r',
  join(dir, 'requirements.txt')
])
sh(python, ['-B', 'scripts/test_convert_megaloc.py', '-v'])
