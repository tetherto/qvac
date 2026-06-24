# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-03-18

This release modernizes the package to use ES modules, improving compatibility with modern JavaScript environments and the Bare runtime. The package maintains full backward compatibility through careful handling of CommonJS dependencies.

### Features

#### ES Module Support

The package now uses native ES modules with `"type": "module"` in package.json. This aligns with modern JavaScript standards and provides better tree-shaking capabilities for bundlers. The main exports now use ES6 `export` syntax while maintaining compatibility with CommonJS dependencies like `cld` and `iso-language-codes` through the `createRequire` utility.

### Internal Improvements

The test suite and examples have been updated to use ES module imports, ensuring consistency throughout the codebase. All 12 tests continue to pass with 62 successful assertions, confirming that the migration maintains complete functionality.

## [0.1.0] - 2024-03-04

### Added
- Initial release of @qvac/langdetect-text-cld2
- Language detection using Google's CLD2 (Compact Language Detector 2)
- API compatibility with @qvac/langdetect-text
- Support for 80+ languages
- Confidence scores for language detection
- TypeScript definitions
- Comprehensive test suite
- Usage examples
