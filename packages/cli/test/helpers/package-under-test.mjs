// Point smoke tests at an installed package without publishing test code with the CLI.
import process from 'bare-process'
import path from 'bare-path'
import { pathToFileURL } from 'bare-url'

const root = process.env.QVAC_CLI_TEST_PACKAGE
  ? pathToFileURL(path.resolve(process.env.QVAC_CLI_TEST_PACKAGE) + path.sep)
  : new URL('../../', import.meta.url)

export function compiledModule(relative) {
  return new URL(`dist/${relative}`, root)
}
