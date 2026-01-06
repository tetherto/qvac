import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import type { QvacTestConfig } from '../types/config.js';
import type { TestDefinition } from '../types/test-definition.js';

/**
 * Load test definitions from configuration
 * @param config Test suite configuration
 * @param configDir Directory where config was loaded from
 */
export async function loadTests(config: QvacTestConfig, configDir: string = process.cwd()): Promise<TestDefinition[]> {
  const testDir = path.resolve(configDir, config.testDir);

  if (!fs.existsSync(testDir)) {
    throw new Error(`Test directory not found: ${testDir}`);
  }

  // Look for test-definitions.ts or test-definitions.js
  const tsPath = path.join(testDir, 'test-definitions.ts');
  const jsPath = path.join(testDir, 'test-definitions.js');

  let definitionsPath: string;
  let needsTranspile = false;

  if (fs.existsSync(jsPath)) {
    definitionsPath = jsPath;
  } else if (fs.existsSync(tsPath)) {
    definitionsPath = tsPath;
    needsTranspile = true;
  } else {
    throw new Error(`Test definitions not found in ${testDir} (looking for test-definitions.ts or .js)`);
  }

  try {
    let modulePathToImport = definitionsPath;

    // If it's a TypeScript file, transpile it first
    if (needsTranspile) {
      const result = await esbuild.build({
        entryPoints: [definitionsPath],
        bundle: true,
        platform: 'node',
        format: 'esm',
        write: false,
        target: 'node18',
        external: ['@tetherto/qvac-test-suite'],
      });

      if (result.outputFiles && result.outputFiles.length > 0) {
        // Write transpiled file to a temporary location
        const tempPath = definitionsPath.replace('.ts', '.mjs');
        fs.writeFileSync(tempPath, result.outputFiles[0].text);
        modulePathToImport = tempPath;

        // Clean up temp file after import
        try {
          const fileUrl = pathToFileURL(modulePathToImport).href;
          const module = await import(fileUrl);

          // Look for 'tests' export or default export
          const tests = module.tests || module.default;

          if (!tests || !Array.isArray(tests)) {
            throw new Error(`Test definitions must export 'tests' array or default array`);
          }

          return tests;
        } finally {
          // Clean up temp file
          if (fs.existsSync(tempPath)) {
            fs.unlinkSync(tempPath);
          }
        }
      }
    }

    // For JS files or if transpilation failed, import directly
    const fileUrl = pathToFileURL(modulePathToImport).href;
    const module = await import(fileUrl);

    // Look for 'tests' export or default export
    const tests = module.tests || module.default;

    if (!tests || !Array.isArray(tests)) {
      throw new Error(`Test definitions must export 'tests' array or default array`);
    }

    return tests;
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load test definitions from ${definitionsPath}: ${errorMessage}`);
  }
}
