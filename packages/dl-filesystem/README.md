# @qvac/dl-filesystem

`@qvac/dl-filesystem` is a data loading library designed to load model weights and other resources from a local filesystem. It provides a simple and efficient way to retrieve files required for AI model inference, training, and other operations directly from a specified directory.

## Usage

### FilesystemDL Class

`FilesystemDL` extends `BaseDL` to provide a unified interface for loading files from a local directory. It is designed to integrate seamlessly with other QVAC AI Runtime libraries and classes.

#### Constructor:

```javascript
const FilesystemDL = require('@qvac/dl-filesystem');

const fsDL = new FilesystemDL({ dirPath: '/path/to/your/models' });
```

- **`dirPath`**: A string representing the local path to the directory containing model files or resources.

#### Methods:

- **`getStream(path)`**: Asynchronously retrieves a readable stream for a specified file path in the local directory.

  ```javascript
  const stream = await fsDL.getStream('model_weights.bin');
  ```

- **`list(directoryPath = '.')`**: Lists the files in a directory relative to the base directory. If no directory is specified, it lists the files in the base directory.

  ```javascript
  const files = await fsDL.list();
  console.log(files); // Output: ['file1.bin', 'file2.bin']
  ```

## Examples

### Loading Models with QVAC Runtime

Below is an example of how `FilesystemDL` can be used within the QVAC AI Runtime to dynamically load models:

```javascript
const Qvac = require('@qvac/rt');
const FilesystemDL = require('@qvac/dl-filesystem');
const Whisper = require('@qvac/transcription-whispercpp');

const qvac = new Qvac({ /* runtime options */ });

// Create an inference instance for Whisper using the local filesystem to load weights
const whisper = qvac.inference.add(new Whisper({
  weights: new FilesystemDL({ dirPath: '/path/to/your/models' }),
  params: { /* model parameters */ }
}));

// Load model weights
await whisper.load();
```

### FilesystemDL in AI Models

The `FilesystemDL` class can be integrated directly within model classes to dynamically fetch and load model files from a local directory.

```javascript
class MyModel {
  constructor(loader) {
    this.loader = loader;
  }

  async load() {
    const weightsStream = await this.loader.getStream('model_weights.bin');
    // Process all the required files from the stream...
  }

  async listFiles() {
    const files = await this.loader.list();
    console.log('Available model files:', files);
  }
}
```

## Development

1. Install dependencies:

   ```bash
   npm install
   ```

2. Run unit tests:

   ```bash
   npm test
   ```

## Notes

- Ensure that the provided directory path exists and contains the necessary model files.
- The loader will throw an error if the directory or the specified file does not exist.
- The `list` method can be used to enumerate the files available in the directory.
