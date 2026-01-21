# QVAC CLI

A powerful command-line interface for managing and interacting with the QVAC ecosystem. QVAC CLI leverages [`bare`](https://bare.pears.com/) as its core runtime for optimal performance and minimal overhead.

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
   - [1. List Remote Models](#1-list-remote-models)
   - [2. Download a Model](#2-download-a-model)
   - [3. Load a Model](#3-load-a-model)
   - [4. List Local Models](#4-list-local-models)
   - [5. Remove a Model](#5-remove-a-model)
- [Command Reference](#command-reference)
   - [`model`](#model)
      - [`model download`](#model-download)
      - [`model load`](#model-load)
      - [`model list`](#model-list)
      - [`model rm`](#model-rm)
   - [`bootstrap`](#bootstrap)
      - [`bootstrap package`](#bootstrap-package)
- [Configuration](#configuration)
- [Development](#development)
   - [Prerequisites](#prerequisites)
   - [Setup](#setup)
- [License](#license)

## Installation

Ensure you have `bare` installed. If you don't have it, you can install it using the following command:

```bash
npm i -g bare
```

Before proceeding with the installation, please generate a **classic GitHub Personal Access Token (PAT)** with the `read:packages` scope. Once generated, add the token to your environment variables using the name `NPM_TOKEN`.

```bash
export NPM_TOKEN=your_personal_access_token
```

Next, create a `.npmrc` file in your home directory with the following content:

```ini
@tetherto:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NPM_TOKEN}
```

This configuration ensures secure access to GitHub Packages when installing scoped packages.

Finally, install the QVAC CLI globally using the following command:

```bash
npm i -g @tetherto/qvac-cli 
```

## Quick Start

In this quick start guide, we will demonstrate how to list, download, load, and manage models using the QVAC CLI.

### 1. List Remote Models

To list all available remote models, use the following command:

```bash
qvac model list --remote
```

Example output:

```
✓ Remote models:...
- embedding:bert_custom:gte-large::355M:q4f16_1:0.1.0
- generation:llama:instruct:3.1:8B:q4f16_1:1.0.0
- generation:llama:instruct:3.2:1B:q4f16_1:1.0.0
- generation:llama:instruct:3.2:3B:q4f16_1:1.0.0
- transcription:whisper:tiny:::q0f32:1.0.0
- translation::indictrans:2:1B:q0f32:1.0.0:en-hi
- translation::indictrans:2:1B:q0f32:1.0.0:hi-en
- translation::indictrans:2:1B:q0f32:1.0.0:hi-hi
- translation:dist:indictrans:2:200M:q0f32:1.0.0:en-hi
- translation:dist:indictrans:2:200M:q0f32:1.0.0:hi-en
- translation:dist:indictrans:2:320M:q0f32:1.0.0:hi-hi
- translation:full:indictrans:2:1B:q0f32:1.0.0:en-hi
- translation:full:indictrans:2:1B:q0f32:1.0.0:hi-en
- translation:full:indictrans:2:1B:q0f32:1.0.0:hi-hi
- translation:marian:opus:::q4f16_1:1.0.0:de-en
- translation:marian:opus:::q4f16_1:1.0.0:de-es
- translation:marian:opus:::q4f16_1:1.0.0:de-it
- translation:marian:opus:::q4f16_1:1.0.0:en-de
- translation:marian:opus:::q4f16_1:1.0.0:en-es
- translation:marian:opus:::q4f16_1:1.0.0:en-it
- translation:marian:opus:::q4f16_1:1.0.0:es-de
- translation:marian:opus:::q4f16_1:1.0.0:es-en
- translation:marian:opus:::q4f16_1:1.0.0:es-it
- translation:marian:opus:::q4f16_1:1.0.0:it-de
- translation:marian:opus:::q4f16_1:1.0.0:it-en
- translation:marian:opus:::q4f16_1:1.0.0:it-es
```

### 2. Download a Model

We will be downloading the `translation:marian:opus:::q4f16_1:1.0.0:en-it` model using the following command:

```bash
qvac model download translation:marian:opus:::q4f16_1:1.0.0:en-it
```

Example output:

```
✓ Model translation:marian:opus:::q4f16_1:1.0.0:en-it successfully downloaded
```

### 3. Load a Model

To load the downloaded translation model, use the following command:

```bash
qvac model load translation:marian:opus:::q4f16_1:1.0.0:en-it
```

This command will load the model and create a REPL session for inference. Example output:

```
params_shard_1.bin has these many parameter records: 19
params_shard_0.bin has these many parameter records: 1
params_shard_3.bin has these many parameter records: 336
params_shard_2.bin has these many parameter records: 1
✓ Model loaded
Entering inference chat mode. Type 'exit' to quit.
QVAC> Hi, my name is Harshit. 
Ciao, mi chiamo Harshit.
QVAC> 
```

### 4. List Local Models

To list all local models, use the following command:

```bash
qvac model list --local
```

Example output:

```
✓ Local models:
- translation:marian:opus:::q4f16_1:1.0.0:en-it
- generation:llama:instruct:3.2:3B:q4f16_1:1.0.0
```

### 5. Remove a Model

To remove a model, use the following command:

```bash
qvac model rm translation:marian:opus:::q4f16_1:1.0.0:en-it
```   

Example output:

```
Model translation:marian:opus:::q4f16_1:1.0.0:en-it removed
```   

## Command Reference

### `model`

Manage models in the QVAC ecosystem. This includes downloading, loading, listing, and removing models.

### `model download`

Download a model and related files from a `Hyperbee`.

```bash
qvac model download <modelAlias>
```

**Arguments:**
- `<modelAlias>` - The alias/name of the model to download

**Options:**
- `-hbk, --hyperbee-key <hyperbee-key>` - Specific hyperbee key to download from (optional)

**Examples:**
```bash
# Download a model by alias
qvac model download generation:llama:instruct:3.2:3B:q4f16_1:1.0.0

# Download from specific hyperbee key
qvac model download generation:llama:instruct:3.2:3B:q4f16_1:1.0.0 --hyperbee-key abc123def456
```

### `model load`

Load a model into memory and launch an interactive REPL for inference.

```bash
qvac model load <modelAlias>
```

**Arguments:**
- `<modelAlias>` - The alias/name of the model to load

**Examples:**
```bash
# Load model and start interactive chat
qvac model load generation:llama:instruct:3.2:3B:q4f16_1:1.0.0
```

> **Note:** Once loaded, you'll enter inference chat mode. Type your prompts and the model will respond. Type `exit` to quit the REPL and unload the model.

### `model list`

List available models, either locally cached or available remotely.

```bash
qvac model list [options]
```

**Options:**
- `--local` - List models available locally (downloaded/cached)
- `--remote` - List all models available remotely

**Examples:**
```bash
# List local models
qvac model list --local

# List remote models
qvac model list --remote
```

> **Note:** You must specify either `--local` or `--remote` - the command requires one of these flags.

### `model rm`

Remove a model and its persistent data from local storage.

```bash
qvac model rm <modelAlias>
```

**Arguments:**
- `<modelAlias>` - The alias/name of the model to remove

**Examples:**
```bash
# Remove a local model
qvac model rm generation:llama:instruct:3.2:3B:q4f16_1:1.0.0
```

> **Warning:** This permanently deletes the model files and associated data. You'll need to download the model again to use it.

### `bootstrap`

Bootstrap QVAC projects and packages.

### `bootstrap package`

Set up a QVAC package for development.

```bash
qvac bootstrap package [options]
```

**Options:**
- `-n, --name <name>` - Name of the package to bootstrap
- `-ls, --list` - List all packages available for bootstrap

**Examples:**
```bash
# List available packages
qvac bootstrap package --list
qvac bootstrap package -ls

# Bootstrap a specific package
qvac bootstrap package --name @tetherto/mlc-marian
qvac bootstrap package -n @tetherto/mlc-marian
```

**What it does:**

1. Downloads package files from GitHub repository
2. Parses dependencies from the main file
3. Creates a project `package.json` with proper run scripts
4. Installs all required dependencies with exact versions

**Requirements:**

- `.npmrc` file must exist in the current directory with your npm configuration
- Valid GitHub token must be supplied through Environment Variable (if accessing private repositories).
- Internet connection for downloading files and dependencies

> **Note:** If you run the command without specifying a package name, it will automatically list all available packages for bootstrap.

## Configuration

The CLI can be configured using environment variables:

- `QVAC_LOGLVL`: Set the logging level (default: 'info')
- `QVAC_CACHE_DIR`: Set a custom cache directory
- `GH_TOKEN`: Github PAT token to use bootstrap capabilities

## Development

### Prerequisites

- Node.js >= 14.0.0
- Bare >= 1.18.3
- npm

### Setup

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```

## License

This project is licensed under the Apache-2.0 License - see the [LICENSE](LICENSE) file for details.
