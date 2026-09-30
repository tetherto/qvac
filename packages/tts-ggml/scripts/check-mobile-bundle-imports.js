'use strict'

const fs = require('fs')
const path = require('path')

const MOBILE_TEST_DIR = path.posix.join('test', 'mobile')
const MOBILE_ENTRY_EXTENSION = '.cjs'
const INTEGRATION_ENTRY_FILE = 'integration.auto.cjs'
const BUNDLED_BACKEND_FILE = 'backend/backend.cjs'
const RELATIVE_SPECIFIER_PREFIX = '.'
const INLINED_SIBLING_PATTERN = /^\.\/([\w-]+)(\.cjs)?$/
const STATIC_IMPORT_PATTERN = /\b(?:require|import)\s*\(\s*(['"])([^'"]+)\1\s*\)/g
const INTEGRATION_MODULE_PATTERN = /\brunIntegrationModule\s*\(\s*(['"])([^'"]+)\1/g

function listMobileEntryFiles(mobileDir) {
  return fs
    .readdirSync(mobileDir)
    .filter((file) => file.endsWith(MOBILE_ENTRY_EXTENSION))
    .sort()
}

function collectSpecifiers(content, pattern) {
  return Array.from(content.matchAll(pattern), (match) => match[2])
}

function isRelativeSpecifier(specifier) {
  return specifier.startsWith(RELATIVE_SPECIFIER_PREFIX)
}

function isFile(candidate) {
  return fs.existsSync(candidate) && fs.statSync(candidate).isFile()
}

function isExistingInlinedSibling(specifier, mobileDir) {
  const sibling = specifier.match(INLINED_SIBLING_PATTERN)
  return sibling !== null && isFile(path.join(mobileDir, sibling[1] + MOBILE_ENTRY_EXTENSION))
}

function describeUnresolvedImport(file, specifier) {
  return `${MOBILE_TEST_DIR}/${file} imports '${specifier}', which does not resolve once the mobile test framework inlines ${MOBILE_TEST_DIR}/*${MOBILE_ENTRY_EXTENSION} into ${BUNDLED_BACKEND_FILE}; only './<sibling>${MOBILE_ENTRY_EXTENSION}' requires of existing ${MOBILE_TEST_DIR} files survive`
}

function describeMissingIntegrationModule(specifier) {
  return `${MOBILE_TEST_DIR}/${INTEGRATION_ENTRY_FILE} runs '${specifier}', which does not exist`
}

function findUnresolvedImportsInFile(file, mobileDir) {
  const content = fs.readFileSync(path.join(mobileDir, file), 'utf8')
  return collectSpecifiers(content, STATIC_IMPORT_PATTERN)
    .filter(isRelativeSpecifier)
    .filter((specifier) => !isExistingInlinedSibling(specifier, mobileDir))
    .map((specifier) => describeUnresolvedImport(file, specifier))
}

function findUnresolvedImports(mobileDir) {
  return listMobileEntryFiles(mobileDir).flatMap((file) =>
    findUnresolvedImportsInFile(file, mobileDir)
  )
}

function findMissingIntegrationModules(mobileDir) {
  const entryPath = path.join(mobileDir, INTEGRATION_ENTRY_FILE)
  if (!isFile(entryPath)) return []
  return collectSpecifiers(fs.readFileSync(entryPath, 'utf8'), INTEGRATION_MODULE_PATTERN)
    .filter((specifier) => !isFile(path.resolve(mobileDir, specifier)))
    .map(describeMissingIntegrationModule)
}

function findMobileBundleImportProblems(packageRoot) {
  const mobileDir = path.join(packageRoot, MOBILE_TEST_DIR)
  return findUnresolvedImports(mobileDir).concat(findMissingIntegrationModules(mobileDir))
}

module.exports = { findMobileBundleImportProblems }
