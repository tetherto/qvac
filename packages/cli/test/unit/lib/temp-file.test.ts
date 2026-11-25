import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { removePrivateTempFile, writePrivateTempFile } from '@/serve/lib/temp-file'

describe('writePrivateTempFile', () => {
  it('writes into a fresh owner-only directory', async () => {
    const a = await writePrivateTempFile('audio.wav', Buffer.from('a'))
    const b = await writePrivateTempFile('audio.wav', Buffer.from('b'))
    try {
      assert.notEqual(dirname(a), dirname(b))
      assert.equal(dirname(dirname(a)), tmpdir())
      assert.deepEqual(await readFile(a), Buffer.from('a'))
      if (process.platform !== 'win32') {
        assert.equal((await stat(dirname(a))).mode & 0o777, 0o700)
        assert.equal((await stat(a)).mode & 0o777, 0o600)
      }
    } finally {
      await removePrivateTempFile(a)
      await removePrivateTempFile(b)
    }
  })

  it('removes the directory when the write fails', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'qvac-temp-file-'))
    // os.tmpdir() reads TMPDIR on POSIX and TEMP/TMP on Windows.
    const tmpVars = ['TMPDIR', 'TEMP', 'TMP'] as const
    const previous = tmpVars.map((name) => process.env[name])
    for (const name of tmpVars) process.env[name] = root
    t.after(async () => {
      tmpVars.forEach((name, index) => {
        if (previous[index] === undefined) delete process.env[name]
        else process.env[name] = previous[index]
      })
      await rm(root, { recursive: true, force: true })
    })

    await assert.rejects(writePrivateTempFile(join('missing', 'x.bin'), Buffer.from('x')), {
      code: 'ENOENT'
    })
    assert.deepEqual(await readdir(root), [])
  })
})

describe('removePrivateTempFile', () => {
  it('removes the file and its directory', async () => {
    const path = await writePrivateTempFile('image.png', Buffer.from('x'))
    await removePrivateTempFile(path)
    await assert.rejects(access(dirname(path)), { code: 'ENOENT' })
  })

  it('leaves directories it did not create alone', async () => {
    await removePrivateTempFile(join(tmpdir(), 'not-ours.bin'))
    await access(tmpdir())
  })
})
