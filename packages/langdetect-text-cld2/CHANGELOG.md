# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.1] - 2026-03-30

### Changed

- README: removed outdated npm Personal Access Token / `.npmrc` setup instructions for installing `@qvac/langdetect-text-cld2`.

## [0.3.0] - 2024-03-23

### Changed
- Replaced `iso-language-codes` dependency with `language-tags` for comprehensive language support
- The `code` field in API responses now returns ISO 639-1/2/3 codes (previously only ISO 639-1)
  - Languages without ISO 639-1 codes now return their ISO 639-3 codes instead of 'und'
  - Example: Hawaiian returns `{ code: 'haw', language: 'Hawaiian' }`

### Added
- Full support for ISO 639-3 language codes (e.g., `haw` for Hawaiian, `chr` for Cherokee, `yue` for Cantonese)
- Comprehensive support for Arabic dialect codes:
  - Moroccan Arabic (`ary`), Egyptian Arabic (`arz`), Tunisian Arabic (`aeb`)
  - Levantine Arabic (`apc`), Mesopotamian Arabic (`acm`), Sudanese Arabic (`apd`)
  - Algerian Arabic (`arq`), Libyan Arabic (`ayl`), Najdi Arabic (`ars`)
  - And many more regional Arabic variants
- Better handling of minority and regional languages that lack ISO 639-1 codes

### Fixed
- Improved language name resolution across all ISO 639 standards (639-1, 639-2, and 639-3)
- `getLangName()` now correctly handles ISO 639-3 codes

### Internal
- Simplified error handling by removing unnecessary try-catch blocks
- Cleaner code structure leveraging `language-tags` library capabilities
- Improved code mapping with better support for CLD2's output variations

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
