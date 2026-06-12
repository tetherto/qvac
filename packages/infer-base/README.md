# infer-base

This library contains the base class for inference addon clients. It defines a common lifecycle for all models, and provides a set of generic methods to interact with the addon.

This package also exports `QvacResponse`, the response class used by all QVAC inference operations.

## Installation

```bash
npm install @qvac/infer-base
```

## Usage

### BaseInference

```javascript
const BaseInference = require('@qvac/infer-base')

class MyInference extends BaseInference {
  constructor(args) {
    super(args)
  }

  getApiDefinition() {
    return 'my-api'
  }

  // Required
  async _load() {
    // Load model configuration to addon, if it's executed with an already loaded instance, it will unload the previous one
  }

  // Optional
  async _loadWeights(loader, close, reportProgressCallback) {
    // Load model weights from the loader
  }

  // Optional
  async _unloadWeights() {
    // Unload model weights from memory
  }

  _getConfigPathNames() {
    return ['config.json']
  }

  async _runInternal(input) {
    // Execute inference and return QvacResponse
    return new this._createResponse(jobId)
  }
}
```

### QvacResponse

`QvacResponse` is exported from this package and provides an interface for handling asynchronous responses with update notifications, error handling, and pause/resume functionality.

```javascript
const { QvacResponse } = require('@qvac/infer-base')

const response = new QvacResponse({
  cancelHandler: async () => { /* cancel logic */ },
  pauseHandler: async () => { /* pause logic */ },
  continueHandler: async () => { /* continue logic */ }
})

// Use the response
response.onUpdate(output => console.log('Update:', output))
response.onFinish(outputs => console.log('Complete:', outputs))

const finalOutputs = await response.await()
```

For detailed QvacResponse documentation, see the response class implementation.

The subclass must implement the following methods:

- `getApiDefinition()`: Returns the API definition for the current environment.
- `_load()`: Loads the model configuration to the addon.
- `_loadNew(config, loader, close, reportProgressCallback)`: Loads new configuration and weights.
- `_loadWeights(loader, close, reportProgressCallback)`: Loads model weights from the provided loader. (Optional)
- `_unloadWeights()`: Unloads the model weights from memory. (Optional)

## API

### Constructor

```javascript
new BaseInference(args)
```

Arguments:

- `args.opts` (optional): Configuration options
  - `stats` (boolean): Whether to collect inference statistics
- `args.logger` (optional): Logger instance
- `args.loader` (optional): Model loader implementation
  - `getFileSize(filepath)`: Get file size in bytes
  - `download(progressReport)`: Download model files
  - `deleteLocal()`: Delete local model files
  - `getStream(filepath)`: Get file stream
- `args.addon` (optional): Addon implementation
  - `loadWeights(params)`: Load model weights
  - `destroy()`: Clean up resources
  - `pause()`: Pause inference
  - `activate()`: Resume inference
  - `stop()`: Stop inference
  - `status()`: Get inference status
  - `append(input)`: Append input to inference
  - `cancel(jobId)`: Cancel a running inference job

### ProgressData Interface

The `ProgressData` interface is used for progress reporting during model loading:

```typescript
interface ProgressData {
    action: 'loadingFile' | 'completeFile'
    totalSize: number
    totalFiles: number
    filesProcessed: number
    currentFile: string
    currentFileProgress: string
    overallProgress: string
}
```

### Methods

#### `getApiDefinition()`

Returns the API definition to use for the current environment. Must be implemented by subclasses.

#### `getState()`

Returns the current state of the inference client, including whether configuration and weights are loaded.

#### `load()`

Loads the model and required files. Must be implemented by subclasses.

#### `loadWeights(loader, close, reportProgressCallback)`

Loads model weights from the provided loader.

- `loader`: Loader to fetch model weights from
- `close` (optional): Whether to close the loader after loading (default: false)
- `reportProgressCallback` (optional): Callback for progress reporting

#### `unloadWeights()`

Unloads the model weights from memory.

#### `loadNew(config, loader, close, reportProgressCallback)`

Loads new configuration and weights.

- `config`: Configuration for the model
- `loader`: Loader to fetch model weights from
- `close` (optional): Whether to close the loader after loading (default: false)
- `reportProgressCallback` (optional): Callback for progress reporting

#### `initProgressReport(weightFiles, callbackFunction)`

Initializes progress reporting for model loading.

#### `download(progressReport)`

Downloads model files.

#### `delete()`

Deletes local model files.

#### `run(input)`

Runs inference on the input data.

#### `unload()`

Unloads the model from memory.

#### `pause()`

Pauses the inference process.

#### `unpause()`

Resumes the inference process.

#### `stop()`

Stops the inference process.

#### `status()`

Gets the current inference status.

#### `destroy()`

Unloads the model and all associated resources, making it unusable.

### Protected Methods

#### `_getConfigs()`

Gets configuration files content.

#### `_getFileContent(filepath)`

Gets file content from loader.

#### `_getConfigPathNames()`

Gets configuration file paths. Must be implemented by subclasses.

#### `_runInternal(input)`

Internal method to run inference. Must be implemented by subclasses.

#### `_createAddon(AddonInterface, ...args)`

Creates addon instance with the provided configuration and interface.

- `AddonInterface`: Interface class to instantiate
- `...args`: Arguments to pass to the interface constructor

#### `_createResponse(jobId)`

Creates a response instance for a job with handlers for cancellation, pausing, and continuation.

#### `outputCallback(addon, event, jobId, data, error)`

Handles output callbacks from the inference process.

#### `saveJobToResponseMapping(jobId, response)`

Saves job to response mapping.

#### `deleteJobMapping(jobId)`

Deletes job mapping.

## License

Apache-2.0