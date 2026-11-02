import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { collectGitHistory } from '../git-history.js'

const execFileAsync = promisify(execFile)

test('Git evidence follows renames and counts each commit once', async () => {
  const root = await gitRepository('quality-git-history-')
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src/old.ts'), 'export const value = 1\n')
  await commit(root, 'add old path', '2026-08-01T10:00:00Z')
  await rename(join(root, 'src/old.ts'), join(root, 'src/current.ts'))
  await commit(root, 'rename path', '2026-09-01T10:00:00Z')
  await writeFile(join(root, 'src/current.ts'), 'export const value = 2\n')
  await commit(root, 'change current path', '2026-09-20T10:00:00Z')

  const history = await collectGitHistory({
    root,
    paths: ['src/current.ts', 'src/missing.ts'],
    now: new Date('2026-09-25T00:00:00Z'),
    windowDays: 180,
  })

  assert.deepEqual(history, [
    {
      path: 'src/current.ts',
      commitCount: 3,
      lastChanged: '2026-09-20',
    },
    {
      path: 'src/missing.ts',
      commitCount: 0,
    },
  ])
})

test('Git evidence is empty but valid when a repository has no commits', async () => {
  const root = await gitRepository('quality-git-empty-')

  assert.deepEqual(
    await collectGitHistory({
      root,
      paths: ['src/new.ts'],
      now: new Date('2026-09-25T00:00:00Z'),
      windowDays: 180,
    }),
    [{ path: 'src/new.ts', commitCount: 0 }],
  )
})

async function gitRepository(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  await execFileAsync('git', ['init'], { cwd: root })
  await execFileAsync('git', ['config', 'user.email', 'quality@example.test'], {
    cwd: root,
  })
  await execFileAsync('git', ['config', 'user.name', 'Quality Test'], {
    cwd: root,
  })
  return root
}

async function commit(
  root: string,
  message: string,
  date: string,
): Promise<void> {
  await execFileAsync('git', ['add', '-A'], { cwd: root })
  await execFileAsync('git', ['commit', '-m', message], {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    },
  })
}
