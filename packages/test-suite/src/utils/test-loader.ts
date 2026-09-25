import * as fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'
import type { QvacTestConfig } from '../types/config.js'
import type { TestDefinition } from '../types/test-definition.js'

/**
 * Load test definitions from configuration
 * @param config Test suite configuration
 * @param configDir Directory where config was loaded from
 */
export async function loadTests(
  config: QvacTestConfig,
  configDir: string = process.cwd()
): Promise<TestDefinition[]> {
  const testDir = path.resolve(configDir, config.testDir)

  if (!fs.existsSync(testDir)) {
    throw new Error(`Test directory not found: ${testDir}`)
  }

  // A catalog directory is the data-first shape: every .json file in it is a
  // slice of the catalog, which is what lets a client in another language read
  // the same tests without a TypeScript toolchain. It takes precedence when
  // present; otherwise the TypeScript/JavaScript module is loaded exactly as
  // before, so nothing changes for a consumer that has not migrated.
  const catalogDir = path.join(testDir, 'catalog')
  if (fs.existsSync(catalogDir)) {
    const fromCatalog = loadCatalogDir(catalogDir)
    if (fromCatalog.length > 0) return fromCatalog
  }

  const jsonPath = path.join(testDir, 'test-definitions.json')
  if (fs.existsSync(jsonPath)) {
    return readDefinitionsJson(jsonPath)
  }

  // Look for test-definitions.ts or test-definitions.js
  const tsPath = path.join(testDir, 'test-definitions.ts')
  const jsPath = path.join(testDir, 'test-definitions.js')

  let definitionsPath: string
  let needsTranspile = false

  if (fs.existsSync(jsPath)) {
    definitionsPath = jsPath
  } else if (fs.existsSync(tsPath)) {
    definitionsPath = tsPath
    needsTranspile = true
  } else {
    throw new Error(
      `Test definitions not found in ${testDir} ` +
        `(looking for catalog/*.json, test-definitions.json, .ts or .js)`
    )
  }

  try {
    let modulePathToImport = definitionsPath

    // If it's a TypeScript file, transpile it first
    if (needsTranspile) {
      const result = await esbuild.build({
        entryPoints: [definitionsPath],
        bundle: true,
        platform: 'node',
        format: 'esm',
        write: false,
        target: 'node18',
        // The framework ships under two names (public npm @qvac, GPR @tetherto),
        // and the pre-monorepo names are still in use by consumers pinned to a
        // released 0.10.x; externalize all four so consumer test files resolve
        // the installed package regardless of which name they pulled it under.
        external: [
          '@qvac/test-suite',
          '@tetherto/test-suite-mono',
          '@qvac/qvac-test-suite',
          '@tetherto/qvac-test-suite'
        ]
      })

      if (result.outputFiles && result.outputFiles.length > 0) {
        // Write transpiled file to a temporary location
        const tempPath = definitionsPath.replace('.ts', '.mjs')
        fs.writeFileSync(tempPath, result.outputFiles[0].text)
        modulePathToImport = tempPath

        // Clean up temp file after import
        try {
          const fileUrl = pathToFileURL(modulePathToImport).href
          const module = await import(fileUrl)

          // Look for 'tests' export or default export
          const tests = module.tests || module.default

          if (!tests || !Array.isArray(tests)) {
            throw new Error(`Test definitions must export 'tests' array or default array`)
          }

          return tests
        } finally {
          // Clean up temp file
          if (fs.existsSync(tempPath)) {
            fs.unlinkSync(tempPath)
          }
        }
      }
    }

    // For JS files or if transpilation failed, import directly
    const fileUrl = pathToFileURL(modulePathToImport).href
    const module = await import(fileUrl)

    // Look for 'tests' export or default export
    const tests = module.tests || module.default

    if (!tests || !Array.isArray(tests)) {
      throw new Error(`Test definitions must export 'tests' array or default array`)
    }

    return tests
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to load test definitions from ${definitionsPath}: ${errorMessage}`)
  }
}

/**
 * Read one JSON file of definitions.
 *
 * Accepts either a bare array or `{ tests: [...] }`, matching what the module
 * form exports, so a file can be moved between the two shapes without being
 * rewritten.
 */
function readDefinitionsJson(file: string): TestDefinition[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to parse ${file}: ${message}`)
  }

  const tests = Array.isArray(parsed) ? parsed : (parsed as { tests?: unknown }).tests
  if (!Array.isArray(tests)) {
    throw new Error(`${file} must contain an array of definitions or { "tests": [...] }`)
  }
  return tests as TestDefinition[]
}

/** Load every .json file in a catalog directory, sorted for a stable order. */
function loadCatalogDir(dir: string): TestDefinition[] {
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()

  const all: TestDefinition[] = []
  const seen = new Map<string, string>()

  for (const name of files) {
    for (const test of readDefinitionsJson(path.join(dir, name))) {
      // A duplicate testId across two files would make the run
      // order-dependent and the report ambiguous, so it is an error here
      // rather than a surprise later.
      const previous = seen.get(test.testId)
      if (previous) {
        throw new Error(`Duplicate testId "${test.testId}" in ${name} and ${previous}`)
      }
      seen.set(test.testId, name)
      all.push(test)
    }
  }

  return all
}
