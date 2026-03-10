# @qvac/langdetect-text-cld2

`@qvac/langdetect-text-cld2` is a language detection library for qvac using Google's Compact Language Detector 2 (CLD2). It provides an interface for detecting the language of a given text, returning either the single most likely language or the top K probable languages. This package offers superior language detection compared to TinyLD with support for 80+ languages.

## Features

- **80+ Language Support**: Detects a wide range of languages compared to TinyLD's limited coverage
- **High Performance**: ~10× faster than similar language detection tools
- **Production Proven**: Built on CLD2, originally developed for Chromium/Google
- **ISO Standards**: Uses `iso-language-codes` for standardized language code mappings
- **Compatible API**: Maintains the same API as `@qvac/langdetect-text` (with async functions)

## Usage

### LangDetect Functions

`@qvac/langdetect-text-cld2` provides functions for detecting the language of a given text. All detection functions are asynchronous.

#### Import:

```javascript
const { detectOne, detectMultiple, getLangName, getISO2FromName } = require("@qvac/langdetect-text-cld2");
```

#### Functions:

- **`detectOne(text)`**: Detects the most probable language of the given text (async).

  ```javascript
  const lang = await detectOne("This is a sample text.");
  console.log(lang); 
  // Output: { code: 'en', language: 'English' }
  ```

- **`detectMultiple(text, topK)`**: Detects the topK probable languages of the given text in descending order of probability (async).

  ```javascript
  const langs = await detectMultiple("Hola, ¿cómo estás?", 3); 
  // Output: [{ code: 'es', language: 'Spanish, Castilian', probability: 0.98 }]
  ```

- **`getLangName(code)`**: Gets the language name from either an ISO2 or ISO3 language code (sync).

  ```javascript
  const name = getLangName('en');
  console.log(name); 
  // Output: 'English'
  ```

- **`getISO2FromName(languageName)`**: Gets the ISO2 code from a language name (sync).

  ```javascript
  const code = getISO2FromName('French');
  console.log(code); 
  // Output: 'fr'
  ```

## Examples

### Detecting Single & Multiple Languages

Below is an example of how the package can be used to detect the language of a given text:

```javascript
const { detectOne, detectMultiple, getLangName, getISO2FromName } = require("@qvac/langdetect-text-cld2");

async function example() {
  const text = "This is a sample text for language detection.";
  
  // Detect single language
  const lang = await detectOne(text);
  console.log('Single language:', lang);
  // Output: { code: 'en', language: 'English' }
  
  // Detect multiple probable languages
  const langs = await detectMultiple(text, 3);
  console.log('Multiple languages:', langs);
  // Output: [{ code: 'en', language: 'English', probability: 0.98 }]
  
  // Language name lookup
  const langName = getLangName('es');
  console.log('Language name:', langName);
  // Output: 'Spanish, Castilian'
  
  // ISO2 code lookup
  const isoCode = getISO2FromName('Japanese');
  console.log('ISO code:', isoCode);
  // Output: 'ja'
}

example().catch(console.error);
```

### Working with Different Scripts

CLD2 supports various writing systems:

```javascript
async function detectVariousScripts() {
  // Japanese
  console.log(await detectOne('これは日本語のテキストです。'));
  // Output: { code: 'ja', language: 'Japanese' }
  
  // Arabic
  console.log(await detectOne('هذا نص عربي للكشف عن اللغة.'));
  // Output: { code: 'ar', language: 'Arabic' }
  
  // Chinese (Simplified vs Traditional)
  console.log(await detectOne('这是简体中文文本。'));
  // Output: { code: 'zh', language: 'Chinese' }
  
  console.log(await detectOne('這是繁體中文文本。'));
  // Output: { code: 'zh', language: 'Chinese' }
  
  // Hebrew
  console.log(await detectOne('זה טקסט בעברית לזיהוי שפה.'));
  // Output: { code: 'he', language: 'Hebrew (modern)' }
}
```

## Development

1. Install dependencies:

 Before proceeding with the installation, please generate a **granular Personal Access Token (PAT)** with the `read-only` scope. Once generated, add the token to your environment variables using the name `NPM_TOKEN`.

  ```bash
  export NPM_TOKEN=your_personal_access_token
  ```

 Next, create a `.npmrc` file in the root of your project with the following content:

  ```ini
  @qvac:registry=https://registry.npmjs.org/
  //registry.npmjs.org/:_authToken={NPM_TOKEN}
  ```

 This configuration ensures secure access to NPM Packages when installing scoped packages.

```bash
npm install
```

2. Run tests:

```bash
npm test
```

## Technical Details

- **Language Detector**: Google's Compact Language Detector 2 (CLD2)
- **Node Bindings**: Uses `cld` npm package for Node.js integration
- **ISO Standards**: Uses `iso-language-codes` for ISO 639 language code mappings
- **Binary Size**: ~1.8MB optimized binary
- **Classification Method**: N-gram–based Naive Bayes classifier (quadgrams for most languages, unigrams for CJK)

## License

This project is licensed under the Apache-2.0 License - see the LICENSE file for details.

For any questions or issues, please open an issue on the GitHub repository.
