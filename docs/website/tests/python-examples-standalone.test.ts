import { describe, it, expect } from 'vitest'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'
import { glob } from 'glob'
import {
  extractEmbeddedPythonRefs,
  localImports,
  siblingModules,
  parsePythonModules,
  validateEmbeddedPythonExamples,
  checkPythonExamples,
  pythonAvailable,
} from '../scripts/lib/python-example-validator'

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url))
const WEBSITE_DIR = path.resolve(TESTS_DIR, '..')
const MONOREPO_ROOT = path.resolve(WEBSITE_DIR, '../..')
const DOCS_CONTENT = path.join(WEBSITE_DIR, 'content', 'docs')

// ---------------------------------------------------------------------------
// Unit tests — fence extraction
// ---------------------------------------------------------------------------

describe('extractEmbeddedPythonRefs', () => {
  it('picks up a python block backed by a repo file', () => {
    const mdx = [
      '# Page',
      '```python file=<rootDir>/packages/sdk-python/examples/quickstart.py title="quickstart.py"',
      '```',
    ].join('\n')

    expect(extractEmbeddedPythonRefs(mdx, 'page.mdx')).toEqual([
      { mdxFile: 'page.mdx', repoPath: 'packages/sdk-python/examples/quickstart.py', line: 2 },
    ])
  })

  it('ignores non-python fences that use file=', () => {
    const mdx = '```ts file=<rootDir>/packages/sdk/examples/quickstart.ts\n```'
    expect(extractEmbeddedPythonRefs(mdx, 'page.mdx')).toEqual([])
  })

  it('ignores inline python with no file= backing', () => {
    const mdx = '```python\nprint("hi")\n```'
    expect(extractEmbeddedPythonRefs(mdx, 'page.mdx')).toEqual([])
  })

  it('does not read fence attributes out of a block body', () => {
    const mdx = [
      '```python',
      '# ```python file=<rootDir>/packages/sdk-python/examples/fake.py',
      '```',
    ].join('\n')

    expect(extractEmbeddedPythonRefs(mdx, 'page.mdx')).toEqual([])
  })

  it('finds every block on a page', () => {
    const mdx = [
      '```python file=<rootDir>/a.py',
      '```',
      'prose',
      '```python file=<rootDir>/b.py',
      '```',
    ].join('\n')

    expect(extractEmbeddedPythonRefs(mdx, 'page.mdx').map((r) => r.repoPath)).toEqual([
      'a.py',
      'b.py',
    ])
  })
})

// ---------------------------------------------------------------------------
// Unit tests — local import resolution
// ---------------------------------------------------------------------------

describe('localImports', () => {
  const siblings = new Set(['_common', 'helpers'])

  it('flags a sibling module', () => {
    expect(localImports(['_common', 'asyncio'], siblings)).toEqual(['_common'])
  })

  it('leaves installed packages alone', () => {
    expect(localImports(['asyncio', 'sys', 'tetherto'], siblings)).toEqual([])
  })

  it('always flags relative imports', () => {
    expect(localImports(['.', '.utils'], siblings)).toEqual(['.', '.utils'])
  })
})

// ---------------------------------------------------------------------------
// Unit tests — Python AST parsing
// ---------------------------------------------------------------------------

describe.runIf(pythonAvailable())('parsePythonModules', () => {
  async function withTempFiles(
    files: Record<string, string>,
    run: (dir: string) => Promise<void> | void,
  ) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'py-example-'))
    try {
      for (const [name, body] of Object.entries(files)) {
        await fs.writeFile(path.join(dir, name), body, 'utf-8')
      }
      await run(dir)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  }

  it('reports the root of each imported module', async () => {
    await withTempFiles(
      { 'a.py': 'import asyncio\nfrom tetherto.qvac_sdk import Client\nfrom _common import x\n' },
      (dir) => {
        const info = parsePythonModules([path.join(dir, 'a.py')]).get(path.join(dir, 'a.py'))
        expect(info?.imports).toEqual(['_common', 'asyncio', 'tetherto'])
      },
    )
  })

  it('ignores imports that only appear inside a docstring', async () => {
    // vla.py really does document its own API this way; a regex-based scanner
    // reads the docstring line as an import.
    await withTempFiles(
      { 'a.py': '"""Doc.\n\nfrom _common import print_progress\n"""\n\nimport sys\n' },
      (dir) => {
        const info = parsePythonModules([path.join(dir, 'a.py')]).get(path.join(dir, 'a.py'))
        expect(info?.imports).toEqual(['sys'])
      },
    )
  })

  it('ignores commented-out imports', async () => {
    await withTempFiles({ 'a.py': '# from _common import x\nimport sys\n' }, (dir) => {
      const info = parsePythonModules([path.join(dir, 'a.py')]).get(path.join(dir, 'a.py'))
      expect(info?.imports).toEqual(['sys'])
    })
  })

  it('sees an import deferred into a function body', async () => {
    await withTempFiles({ 'a.py': 'def main():\n    import _common\n' }, (dir) => {
      const info = parsePythonModules([path.join(dir, 'a.py')]).get(path.join(dir, 'a.py'))
      expect(info?.imports).toEqual(['_common'])
    })
  })

  it('reports a syntax error instead of imports', async () => {
    await withTempFiles({ 'a.py': 'def broken(:\n' }, (dir) => {
      const info = parsePythonModules([path.join(dir, 'a.py')]).get(path.join(dir, 'a.py'))
      expect(info?.syntaxError).toMatch(/line 1/)
      expect(info?.imports).toBeUndefined()
    })
  })

  it('keeps relative imports distinguishable', async () => {
    await withTempFiles({ 'a.py': 'from .utils import x\nfrom . import y\n' }, (dir) => {
      const info = parsePythonModules([path.join(dir, 'a.py')]).get(path.join(dir, 'a.py'))
      expect(info?.imports).toEqual(['.', '.utils'])
    })
  })
})

// ---------------------------------------------------------------------------
// Unit tests — the rule itself
// ---------------------------------------------------------------------------

describe('validateEmbeddedPythonExamples', () => {
  const root = '/repo'
  const dir = 'packages/sdk-python/examples'
  const siblingsByDir = new Map([[dir, new Set(['_common', 'quickstart', 'ocr'])]])

  function ref(name: string) {
    return { mdxFile: 'page.mdx', repoPath: `${dir}/${name}`, line: 10 }
  }

  it('passes an example that only imports installed packages', () => {
    const modules = new Map([
      [path.join(root, dir, 'quickstart.py'), { imports: ['asyncio', 'sys', 'tetherto'] }],
    ])

    expect(
      validateEmbeddedPythonExamples([ref('quickstart.py')], root, modules, siblingsByDir),
    ).toEqual([])
  })

  it('fails an example importing a helper the docs never show', () => {
    const modules = new Map([
      [path.join(root, dir, 'quickstart.py'), { imports: ['_common', 'asyncio'] }],
    ])

    const findings = validateEmbeddedPythonExamples(
      [ref('quickstart.py')],
      root,
      modules,
      siblingsByDir,
    )

    expect(findings).toHaveLength(1)
    expect(findings[0]!.kind).toBe('local-import')
    expect(findings[0]!.detail).toContain('_common')
    expect(findings[0]!.detail).toContain('ModuleNotFoundError')
  })

  it('allows a local import when that file is embedded too', () => {
    const modules = new Map([
      [path.join(root, dir, 'quickstart.py'), { imports: ['ocr'] }],
      [path.join(root, dir, 'ocr.py'), { imports: ['sys'] }],
    ])

    expect(
      validateEmbeddedPythonExamples(
        [ref('quickstart.py'), ref('ocr.py')],
        root,
        modules,
        siblingsByDir,
      ),
    ).toEqual([])
  })

  it('fails a relative import even if the target is embedded', () => {
    const modules = new Map([[path.join(root, dir, 'quickstart.py'), { imports: ['.ocr'] }]])

    const findings = validateEmbeddedPythonExamples(
      [ref('quickstart.py'), ref('ocr.py')],
      root,
      modules,
      siblingsByDir,
    )

    expect(findings).toHaveLength(1)
    expect(findings[0]!.detail).toContain('relative import')
  })

  it('surfaces a syntax error', () => {
    const modules = new Map([
      [path.join(root, dir, 'quickstart.py'), { syntaxError: 'line 3: invalid syntax' }],
    ])

    const findings = validateEmbeddedPythonExamples(
      [ref('quickstart.py')],
      root,
      modules,
      siblingsByDir,
    )

    expect(findings).toHaveLength(1)
    expect(findings[0]!.kind).toBe('syntax-error')
  })
})

// ---------------------------------------------------------------------------
// Integration — every Python example the docs actually embed
// ---------------------------------------------------------------------------

describe('embedded Python examples', () => {
  it('has python3 available to parse them', () => {
    expect(pythonAvailable()).toBe(true)
  })

  it('embeds at least one Python example', async () => {
    const mdxPaths = await glob('**/*.mdx', {
      cwd: DOCS_CONTENT,
      absolute: true,
      ignore: ['reference/api/v*.mdx', 'reference/release-notes/v*.mdx'],
    })

    const { refs } = await checkPythonExamples(mdxPaths, WEBSITE_DIR, MONOREPO_ROOT)
    expect(refs.length).toBeGreaterThan(0)
  })

  it('are all standalone and parse cleanly', async () => {
    const mdxPaths = await glob('**/*.mdx', {
      cwd: DOCS_CONTENT,
      absolute: true,
      ignore: ['reference/api/v*.mdx', 'reference/release-notes/v*.mdx'],
    })

    const { findings } = await checkPythonExamples(mdxPaths, WEBSITE_DIR, MONOREPO_ROOT)

    if (findings.length > 0) {
      const details = findings
        .map((f) => `  ${f.mdxFile}:${f.line} → ${f.repoPath}: ${f.detail}`)
        .join('\n')
      expect.fail(`${findings.length} embedded Python example(s) are not standalone:\n${details}`)
    }
  })

  it('every examples directory the docs draw from is free of shared helpers', async () => {
    // The rule above is per-embedded-file. This one catches the other half:
    // a helper module left in the directory is a standing invitation to import
    // it again.
    const mdxPaths = await glob('**/*.mdx', {
      cwd: DOCS_CONTENT,
      absolute: true,
      ignore: ['reference/api/v*.mdx', 'reference/release-notes/v*.mdx'],
    })

    const { refs } = await checkPythonExamples(mdxPaths, WEBSITE_DIR, MONOREPO_ROOT)
    const dirs = new Set(refs.map((r) => path.dirname(r.repoPath)))

    for (const dir of dirs) {
      const siblings = await siblingModules(path.join(MONOREPO_ROOT, dir))
      expect(siblings.has('_common'), `${dir}/_common.py is back`).toBe(false)
    }
  })
})
