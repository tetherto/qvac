# @qvac/langdetect-text

`@qvac/langdetect-text` is a language detection library for qvac. It provides an interface for detecting the language of a given text, returning either the single most likely language or the top K probable languages.

## Usage

### LangDetect Class

`LangDetect` provides a unified interface for detecting the language of a given text. It integrates seamlessly with other QVAC AI Runtime libraries and classes.

#### Constructor:

```javascript
const LangDetect = require("@qvac/langdetect-text");
const langDetect = new LangDetect();
```

#### Methods:

- **`detectOne(text)`**: Detects the most probable language of the given text.

  ```javascript
  const lang = langDetect.detectOne("This is a sample text.");
  console.log(lang); 
  // Output: { code: 'en', language: 'English' }
  ```

- **`detectMultiple(text, topK)`**: Detects the topK probable languages of the given text in descending order of probability.

  ```javascript
  const langs = langDetect.detectMultiple("Hola, cómo estás?", 3); 
  // Output: [{ code: 'es', language: 'Spanish', probability: 0.7253999999999999 }, { code: 'la', language: 'Latin', probability: 0.07142857142857142 }, { code: 'pt', language: 'Portuguese', probability: 0.007935714285714284 }]
  ```

## Examples

### Detecting Single & Multiple Languages

Below is an example of how `LangDetect` can be used to detect the language of a given text:

```javascript
const LangDetect = require("@qvac/langdetect-text");

const langDetect = new LangDetect();

const text = "This is a sample text.";

const lang = langDetect.detectOne(text);
const langs = langDetect.detectMultiple(text, 3);
```

## Development

1. Install dependencies:

```bash
npm install
```

2. Run tests:

```bash
npm test
```

## License

This project is licensed under the Apache-2.0 License - see the LICENSE file for details.

For any questions or issues, please open an issue on the GitHub repository.
