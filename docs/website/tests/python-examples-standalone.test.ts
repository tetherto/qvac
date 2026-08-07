import { describe, it, expect } from 'vitest'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  runExampleIsolated,
  siblingModules,
  checkPythonExamples,
  pythonAvailable,
} from '../scripts/lib/python-example-validator'

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url))
const WEBSITE_DIR = path.resolve(TESTS_DIR, '..')
const MONOREPO_ROOT = path.resolve(WEBSITE_DIR, '../..')

// ---------------------------------------------------------------------------
// The isolation runner, exercised against synthetic examples
// ---------------------------------------------------------------------------

describe.runIf(pythonAvailable())('runExampleIsolated', () => {
  async function withExamples(
    files: Record<string, string>,
    run: (dir: string, siblings: Set<string>) => Promise<void>,
  ) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'py-src-'))
    try {
      for (const [name, body] of Object.entries(files)) {
        await fs.writeFile(path.join(dir, name), body, 'utf-8')
      }
      await run(dir, await siblingModules(dir))
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  }

  it('passes an example that stands on its own', async () => {
    await withExamples(
      {
        'ok.py':
          'import asyncio\nimport sys\n' +
          'from tetherto.qvac_sdk import Client\n\n' +
          'async def main():\n    return 0\n\n' +
          'if __name__ == "__main__":\n    sys.exit(asyncio.run(main()))\n',
      },
      async (dir, siblings) => {
        expect(await runExampleIsolated(path.join(dir, 'ok.py'), siblings)).toEqual({ ok: true })
      },
    )
  })

  it('fails an example that imports a sibling helper', async () => {
    await withExamples(
      {
        '_common.py': 'def print_progress(p):\n    pass\n',
        'bad.py': 'import sys\nfrom _common import print_progress\n',
      },
      async (dir, siblings) => {
        const result = await runExampleIsolated(path.join(dir, 'bad.py'), siblings)
        expect(result.ok).toBe(false)
        expect(result.kind).toBe('missing-module')
        expect(result.module).toBe('_common')
      },
    )
  })

  it('catches a sibling import that sits after a third-party one', async () => {
    // The reason installed packages are stubbed: without it the missing
    // tetherto import would raise first and hide this.
    await withExamples(
      {
        '_common.py': 'x = 1\n',
        'bad.py': 'from tetherto.qvac_sdk import Client\nfrom _common import x\n',
      },
      async (dir, siblings) => {
        const result = await runExampleIsolated(path.join(dir, 'bad.py'), siblings)
        expect(result.kind).toBe('missing-module')
        expect(result.module).toBe('_common')
      },
    )
  })

  it('catches a sibling pulled in dynamically', async () => {
    await withExamples(
      {
        '_common.py': 'x = 1\n',
        'bad.py': 'import importlib\n_c = importlib.import_module("_common")\n',
      },
      async (dir, siblings) => {
        const result = await runExampleIsolated(path.join(dir, 'bad.py'), siblings)
        expect(result.kind).toBe('missing-module')
        expect(result.module).toBe('_common')
      },
    )
  })

  it('catches a sibling reached by a sys.path hack', async () => {
    await withExamples(
      {
        'helpers.py': 'x = 1\n',
        'bad.py':
          'import sys, os\n' +
          'sys.path.insert(0, os.path.dirname(__file__))\n' +
          'import helpers\n',
      },
      async (dir, siblings) => {
        const result = await runExampleIsolated(path.join(dir, 'bad.py'), siblings)
        expect(result.kind).toBe('missing-module')
        expect(result.module).toBe('helpers')
      },
    )
  })

  it('does not run the __main__ entry point', async () => {
    // Otherwise the check would need a worker and a model download.
    await withExamples(
      {
        'ok.py':
          'import sys\n\n' +
          'if __name__ == "__main__":\n    raise SystemExit("must not run")\n',
      },
      async (dir, siblings) => {
        expect(await runExampleIsolated(path.join(dir, 'ok.py'), siblings)).toEqual({ ok: true })
      },
    )
  })

  it('tolerates module-level use of a stubbed package', async () => {
    await withExamples(
      {
        'ok.py':
          'from tetherto.qvac_sdk.models import WHISPER_TINY\n' +
          'MODELS = [WHISPER_TINY]\n' +
          'NAME = str(WHISPER_TINY)\n',
      },
      async (dir, siblings) => {
        expect(await runExampleIsolated(path.join(dir, 'ok.py'), siblings)).toEqual({ ok: true })
      },
    )
  })

  it('reports a syntax error', async () => {
    await withExamples({ 'bad.py': 'def broken(:\n' }, async (dir, siblings) => {
      const result = await runExampleIsolated(path.join(dir, 'bad.py'), siblings)
      expect(result.ok).toBe(false)
      expect(result.kind).toBe('syntax-error')
      expect(result.detail).toMatch(/line 1/)
    })
  })
})

// ---------------------------------------------------------------------------
// Integration — the real examples directory
// ---------------------------------------------------------------------------

describe('Python examples', () => {
  it('has python3 available to run them', () => {
    expect(pythonAvailable()).toBe(true)
  })

  it('every example runs standalone when copied out of the repo', async () => {
    const { checked, findings } = await checkPythonExamples(MONOREPO_ROOT)

    expect(checked.length).toBeGreaterThan(0)

    if (findings.length > 0) {
      const details = findings.map((f) => `  ${f.file}: ${f.detail}`).join('\n')
      expect.fail(`${findings.length} of ${checked.length} example(s) are not standalone:\n${details}`)
    }
  }, 180_000)
})
