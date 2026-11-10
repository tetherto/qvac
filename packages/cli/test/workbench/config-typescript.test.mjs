import { importConfig } from '#config-import'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { loadConfig } from '../../dist/lib/config.js'

function project(t, files) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qvac native #ts-')))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(dir, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents))
  }
  return path.join(dir, 'qvac.config.ts')
}
const loaders = {
  sdk: loadConfig,
  workspace: async (file) => (await importConfig(pathToFileURL(file).href)).default
}

for (const [name, load] of Object.entries(loaders)) {
  test(`${name} config transforms native TypeScript and resolves the local graph`, async (t) => {
    const file = project(t, {
      'qvac.config.ts': `import { value } from './dependency.js'; import { indexed } from './directory'; import data from './data.json';
        enum Mode { Answer=40 }; namespace Values { export const extra=1 }; class Box { constructor(public value:number) {} }
        export default { answer:new Box(Mode.Answer+Values.extra+value).value, indexed, data }`,
      'dependency.ts': 'export const value:number=1',
      'dependency.js': 'throw new Error("TypeScript counterpart must win")',
      'directory/index.ts': "import { value } from '../dependency'; export const indexed=value",
      'data.json': { value: 'json without import attributes' }
    })
    assert.deepEqual(await load(file), {
      answer: 42,
      indexed: 1,
      data: { value: 'json without import attributes' }
    })
  })

  test(`${name} config preserves JSONC extends, aliases, baseUrl and import conditions`, async (t) => {
    const file = project(t, {
      'package.json': { type: 'module', imports: { '#internal': './internal.mjs' } },
      'tsconfig.json':
        '{ // comment\n "extends":"./settings/base", "compilerOptions":{"baseUrl":".",}, }',
      'settings/base.json': {
        compilerOptions: {
          paths: { '@fixture/*': ['./lib/*'], '@fixture/exact': ['./special.ts'] }
        }
      },
      'qvac.config.ts':
        "import { value } from '@fixture/value'; import exact from '@fixture/exact'; import base from 'base'; import condition from 'conditional'; import internal from '#internal';export default {value,exact,base,condition,internal}",
      'lib/value.ts': 'export const value=42',
      'special.ts': "export default 'exact'",
      'base.ts': "export default 'baseUrl'",
      'internal.mjs': "export default 'package-imports'",
      'node_modules/conditional/package.json': {
        type: 'module',
        exports: { '.': { import: './import.mjs', require: './require.cjs' } }
      },
      'node_modules/conditional/import.mjs': "export default 'import-condition'",
      'node_modules/conditional/require.cjs':
        "throw new Error('require condition must not be selected')"
    })
    assert.deepEqual(await load(file), {
      value: 42,
      exact: 'exact',
      base: 'baseUrl',
      condition: 'import-condition',
      internal: 'package-imports'
    })
  })

  test(`${name} config leaves installed CommonJS packages on the native loader`, async (t) => {
    const file = project(t, {
      'qvac.config.ts': "import value from 'fixture-commonjs';export default {value}",
      'node_modules/fixture-commonjs/package.json': { main: 'index.cjs' },
      'node_modules/fixture-commonjs/index.cjs': "module.exports=require('./dep.cjs')",
      'node_modules/fixture-commonjs/dep.cjs': 'module.exports=42'
    })
    assert.deepEqual(await load(file), { value: 42 })
  })

  test(`${name} config reports unsupported compiler syntax and field transforms clearly`, async (t) => {
    for (const [files, expected] of [
      [
        {
          'qvac.config.ts': "import value from './view.tsx';export default value",
          'view.tsx': 'export default <div/>'
        },
        /JSX is unsupported/
      ],
      [
        {
          'qvac.config.ts':
            'function decorator(value:Function){}; @decorator class Example {};export default Example'
        },
        /Node-supported TypeScript/
      ],
      [
        {
          'qvac.config.ts': 'export default {}',
          'tsconfig.json': { compilerOptions: { useDefineForClassFields: false } }
        },
        /assignment-style fields/
      ]
    ]) {
      await assert.rejects(load(project(t, files)), expected)
    }
  })
}

test('separate TypeScript configs isolate aliases and repeated imports refresh local modules', async (t) => {
  const first = project(t, {
    'qvac.config.ts': "import value from '@value';export default {value}",
    'value.ts': 'export default 1',
    'tsconfig.json': { compilerOptions: { paths: { '@value': ['./value.ts'] } } }
  })
  const second = project(t, {
    'qvac.config.ts': "import value from '@value';export default {value}",
    'value.ts': 'export default 2',
    'tsconfig.json': { compilerOptions: { paths: { '@value': ['./value.ts'] } } }
  })
  assert.deepEqual(await loaders.workspace(first), { value: 1 })
  assert.deepEqual(await loaders.workspace(second), { value: 2 })
  fs.writeFileSync(path.join(path.dirname(first), 'value.ts'), 'export default 3')
  assert.deepEqual(await loaders.workspace(first), { value: 3 })
})

test('plain JavaScript config retains standard strict ESM resolution', async (t) => {
  const file = project(t, {
    'qvac.config.ts': 'export default {}',
    'config.mjs': "import './missing-extension';export default {}",
    'missing-extension.js': 'export default 1'
  })
  await assert.rejects(
    importConfig(pathToFileURL(path.join(path.dirname(file), 'config.mjs')).href),
    { code: 'ERR_MODULE_NOT_FOUND' }
  )
})

test('inherited transform settings respect explicit native-field override and tsconfig cycles fail', async (t) => {
  const file = project(t, {
    'qvac.config.ts': 'export default {value:42}',
    'tsconfig.json': { extends: './base.json', compilerOptions: { useDefineForClassFields: true } },
    'base.json': { compilerOptions: { target: 'ES2020', useDefineForClassFields: false } }
  })
  assert.deepEqual(await loaders.workspace(file), { value: 42 })
  fs.writeFileSync(
    path.join(path.dirname(file), 'base.json'),
    JSON.stringify({ extends: './tsconfig.json' })
  )
  await assert.rejects(loaders.workspace(file), /Circular tsconfig extends/)
})

test('TypeScript package exports transform without switching to require conditions', async (t) => {
  const file = project(t, {
    'qvac.config.ts': "import value from 'typed-package';export default {value}",
    'node_modules/typed-package/package.json': {
      exports: { import: './index.ts', require: './wrong.cjs' }
    },
    'node_modules/typed-package/index.ts': "import {value} from './value.js';export default value",
    'node_modules/typed-package/value.ts': 'enum Answer {value=42};export const value=Answer.value',
    'node_modules/typed-package/wrong.cjs': "throw new Error('wrong export')"
  })
  assert.deepEqual(await loaders.workspace(file), { value: 42 })
})

test('JSON modules preserve special keys and type attributes', async (t) => {
  const file = project(t, {
    'qvac.config.ts':
      "import data from './data.json' with {type:'json'};export default {own:Object.hasOwn(data,'__proto__'),value:data.__proto__}",
    'data.json': '{"__proto__":42}'
  })
  assert.deepEqual(await loaders.workspace(file), { own: true, value: 42 })
})

test('workspace package symlinks retain a shared module instance', async (t) => {
  const file = project(t, {
    'qvac.config.ts': "import value from 'shared';export default value",
    'workspace/package.json': { type: 'module', exports: './index.mjs' },
    'workspace/index.mjs': 'export default { token: {} }'
  })
  const dir = path.dirname(file)
  fs.mkdirSync(path.join(dir, 'node_modules'))
  fs.symlinkSync(path.join(dir, 'workspace'), path.join(dir, 'node_modules/shared'), 'dir')
  const direct = await import(pathToFileURL(path.join(dir, 'workspace/index.mjs')).href)
  assert.equal(await loaders.workspace(file), direct.default)
})

test('extensionless directories honor package main before index', async (t) => {
  const file = project(t, {
    'qvac.config.ts': "import value from './local-package';export default {value}",
    'local-package/package.json': { main: './entry.js' },
    'local-package/entry.ts': 'export default 42',
    'local-package/index.ts': "throw new Error('package main must win')"
  })
  assert.deepEqual(await loaders.workspace(file), { value: 42 })
})
