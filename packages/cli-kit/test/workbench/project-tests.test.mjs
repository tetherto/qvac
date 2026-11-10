import assert from 'node:assert/strict'
import test from 'node:test'
import { testCommand } from '../../dist/lib/runtime/project.js'

const fs = (files) => ({
  existsSync: (p) => Object.keys(files).some((f) => p.endsWith(`/${f}`)),
  readFileSync: (p) => files[Object.keys(files).find((f) => p.endsWith(`/${f}`))],
  readdirSync: () => Object.keys(files)
})

test('a project says how its tests run, from its manifests', () => {
  const cases = [
    [{ 'package.json': '{"scripts":{"test":"node --test"}}' }, 'npm test'],
    [
      { 'package.json': '{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}' },
      null
    ],
    [{ 'Cargo.toml': '[package]' }, 'cargo test'],
    [{ 'go.mod': 'module x' }, 'go test ./...'],
    [{ 'pyproject.toml': '[tool.pytest.ini_options]' }, 'python3 -m pytest'],
    [{ 'bowling.py': '', 'bowling_test.py': '' }, 'python3 -m unittest discover -p "*_test.py"'],
    [{ 'test_api.py': '' }, 'python3 -m unittest discover -p "test_*.py"'],
    [
      { 'CMakeLists.txt': '' },
      'cmake -S . -B build && cmake --build build && ctest --test-dir build'
    ],
    [{ Makefile: 'build:\n\tcc x.c\ntest:\n\t./x' }, 'make test'],
    [{ 'README.md': '' }, null]
  ]
  for (const [files, expected] of cases) {
    assert.equal(testCommand('/p', fs(files)), expected, JSON.stringify(files))
  }
})
