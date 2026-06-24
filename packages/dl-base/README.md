# @qvac/dl-base

This is the base class for QVAC dataloader libraries. It aims to provide a common interface for loading data from various sources.

## Installation

```bash
npm i @qvac/dl-base
```

## Usage

Extend the base class and implement the following methods:
- `_open()`: Initialize the dataloader / client
- `_close()`: Clean up the dataloader / client 
- `getStream(path)`: Return a readable stream for the given path
- `list(path)`: Return a list of files in the given path

> NOTE: To open/close the resource, call `ready()` or `close()`. They extend functionality from [ready-resource](https://github.com/holepunchto/ready-resource) to handle single resource management

A sample HTTP dataloader implementation is shown below:

```javascript
const Base = require('@qvac/dl-base')
const axios = require('axios')

class HTTPDL extends Base {
  async _open () {
    this.client = axios.create({
      baseURL: this.opts.url
    })
  }

  async _close () {
    this.client = null
  }

  async list (path) {
    const resp = await this.client.get(path)
    return resp.data
  }

  async getStream (path) {
    const resp = await this.client.get(path, { responseType: 'stream' })
    return resp.data
  }
}

module.exports = HTTPDL
```