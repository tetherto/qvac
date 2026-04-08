# @qvac/dl-hyperdrive

`@qvac/dl-hyperdrive` is a data loading library designed to load model weights and other resources from a [Hyperdrive](https://github.com/holepunchto/hyperdrive) instance. It leverages the `Hyperdrive` distributed file system for efficient peer-to-peer file sharing, enabling dynamic loading of files required for AI model inference, training, and other operations.

## Usage

### HyperDriveDL Class

[HyperDriveDL](index.d.ts) extends [BaseDL](https://github.com/tetherto/dl-base/blob/dev/index.d.ts) to provide a unified interface for loading files from a Hyperdrive instance. It integrates seamlessly with other QVAC AI Runtime libraries and classes.

#### Constructor:

```javascript
const HyperDriveDL = require("@qvac/dl-hyperdrive");

const hdDL = new HyperDriveDL({ key: "hd://your_hyperdrive_key" });
```

- **`key`** (optional): A string representing the [Hyperdrive](https://github.com/holepunchto/hyperdrive) key with the `hd://` protocol prefix.
- **`store`** (optional): A [Corestore](https://github.com/holepunchto/corestore) instance for managing storage. If not provided, the Hyperdrive will use an in-memory store.
- **`drive`** (optional): A [Hyperdrive](https://github.com/holepunchto/hyperdrive) instance. If provided, the Hyperdrive will use the provided instance instead of creating a new one.

Note: If both `key` and `drive` are provided, the `key` will be ignored.

#### Methods:

- **`ready()`**: Initializes the [Hyperdrive](https://github.com/holepunchto/hyperdrive) client. This method must be called before interacting with the Hyperdrive.

  ```javascript
  await hdDL.ready();
  ```

- **`getStream(path)`**: Asynchronously retrieves a readable stream for a specified file path in the [Hyperdrive](https://github.com/holepunchto/hyperdrive).

  ```javascript
  const stream = await hdDL.getStream("/path/to/file");
  ```

- **`list(directoryPath)`**: Asynchronously lists files in a given directory in the [Hyperdrive](https://github.com/holepunchto/hyperdrive). By default, it lists files from the root directory.

  ```javascript
  const files = await hdDL.list("/");
  console.log(files); // Output: ['file1.bin', 'file2.bin']
  ```

- **`download(path, opts)`**: Downloads files to local cache or directly to disk. Returns an object with trackers that can be used to monitor and cancel downloads.

  ```javascript
  // Download a single file to cache
  const download = await hdDL.download("/path/to/file");
  console.log("Download started", download);
  
  // Wait for download to complete and get results
  const results = await download.await();
  console.log("Download completed:", results);
  
  // Download a directory to cache
  const dirDownload = await hdDL.download("/path/to/directory/");
  console.log(`Directory download started with ${dirDownload.trackers.length} trackers`);
  
  // Download with progress tracking
  const progressReport = new ProgressReport({ "/path/to/file": 1000 }, callback);
  const downloadWithProgress = await hdDL.download("/path/to/file", progressReport);
  const progressResults = await downloadWithProgress.await(); // Wait for completion
  
  // Download directly to disk
  const diskDownload = await hdDL.download("/path/to/file", { 
    diskPath: "./downloads" 
  });
  const diskResults = await diskDownload.await(); // Wait for file to be saved to disk
  
  // Download to disk with progress tracking
  const diskProgressDownload = await hdDL.download("/path/to/file", {
    diskPath: "./downloads",
    progressReporter: progressReport
  });
  
  // Download with progress callback
  const callbackDownload = await hdDL.download("/path/to/file", {
    diskPath: "./downloads",
    progressCallback: (data) => console.log("Progress:", data)
  });
  ```

- **`await()`**: Waits for all downloads to complete and returns an array of results. This method is available on the download object returned by `download()`.
- **`cancel()`**: Cancels active downloads. This method is available on the download object returned by `download()`.

  ```javascript
  const download = await hdDL.download("/path/to/file");
  
  // Wait for download to complete and get results
  const results = await download.await();
  console.log(results);
  // Output: [{ file: '/path/to/file', error: null, cached: false }]
  
  // Check for errors
  results.forEach(result => {
    if (result.error) {
      console.error(`Failed to download ${result.file}:`, result.error);
    } else {
      console.log(`Successfully downloaded ${result.file}`);
    }
  });
  
  // Cancel the download (if still in progress)
  await download.cancel();
  
  // Multiple downloads can be managed individually
  const file1Download = await hdDL.download("/file1.txt");
  const file2Download = await hdDL.download("/file2.txt");
  
  // Wait for specific downloads to complete and get results
  const results1 = await file1Download.await();
  const results2 = await file2Download.await();
  
  // Or cancel them
  await file1Download.cancel(); // Cancel only file1
  await file2Download.cancel(); // Cancel only file2
  ```

- **`cached(path)`**: Checks if a file or directory is cached locally.

  ```javascript
  const isCached = await hdDL.cached("/path/to/file");
  console.log(`File is cached: ${isCached}`);
  ```

- **`deleteLocal(path)`**: Deletes cached files from local storage.

  ```javascript
  const deleted = await hdDL.deleteLocal("/path/to/file");
  console.log(`File deleted: ${deleted}`);
  
  // Delete all cached files
  await hdDL.deleteLocal();
  ```


- **`close()`**: Stops the [Hyperdrive](https://github.com/holepunchto/hyperdrive) client and releases resources.

  ```javascript
  await hdDL.close();
  ```

## Examples

### Loading Models with QVAC Runtime

Below is an example of how [HyperDriveDL](index.d.ts) can be used within the QVAC AI Runtime to dynamically load models:

```javascript
const Qvac = require("qvac-rt-local");
const HyperDriveDL = require("@qvac/dl-hyperdrive");
const MLCWhisper = require("qvac-lib-inference-addon-mlc-whisper");

const qvac = new Qvac({
  /* runtime options */
});

// Create an inference instance for Whisper using Hyperdrive to load weights
const whisper = qvac.inference.add(
  new MLCWhisper({
    weights: new HyperDriveDL({ key: "hd://your_hyperdrive_key" }),
    params: {
      /* model parameters */
    },
  })
);

// Load model weights
await whisper.load();
```

### HyperDriveDL in AI Models

The [HyperDriveDL](index.d.ts) class can be integrated directly within model classes to dynamically fetch and load model files from a [Hyperdrive](https://github.com/holepunchto/hyperdrive) instance.

```javascript
class MyModel {
  constructor(loader) {
    this.loader = loader;
  }

  async load() {
    const weightsStream = await this.loader.getStream("model_weights.bin");
    // Process all the required files from the stream...
  }
}
```

### Script Usage

This repository includes a script that allows you to serve files from a specified folder over [Hyperdrive](https://github.com/holepunchto/hyperdrive). To run the script using npm:

1. **Run the script with a folder path argument:**

   ```bash
   npm run hd-provider -- ./path/to/model/files ./path/to/storage(optional)
   ```

   This command will start serving files from the specified folder over [Hyperdrive](https://github.com/holepunchto/hyperdrive) and output the Hyperdrive key, which can be used by clients to access the files.

   The path to storage is optional. If it's not provided, the files will be served from memory.

## Development

1. Install dependencies:
   ```bash
   npm install
   ```

2. Run unit tests:

   ```bash
   npm test
   ```

3. Run all tests with coverage and generate HTML reports:

   ```powershell
   npm run coverage:unit           # Unit test coverage (HTML: coverage/unit/index.html)
   npm run coverage:integration   # Integration test coverage (HTML: coverage/integration/index.html)
   npm run coverage               # All tests coverage (HTML: coverage/all/index.html)
   ```

   - These commands run the respective test suites and generate coverage reports in the `coverage/unit`, `coverage/integration`, and `coverage/all` directories.
   - To view the HTML report, open the corresponding `index.html` file in your browser.

4. Run only unit or integration tests (without coverage):

   ```powershell
   npm run test:unit
   npm run test:integration
   ```

- All test files must be named with the `.test.js` suffix and placed in the appropriate `test/unit` or `test/integration` directories.
- Coverage is collected using `brittle-bare --coverage` and HTML reports are generated using Istanbul.