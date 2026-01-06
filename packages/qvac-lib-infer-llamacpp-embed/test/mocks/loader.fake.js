'use strict'

const Base = require('@qvac/dl-base')
const Buffer = require('bare-buffer')
const path = require('bare-path')
const { Readable } = require('bare-stream')

const files = {
  'mlc-chat-config.json': JSON.stringify({
    conv_template: {
      roles: {
        user: '<|start_header_id|>user',
        assistant: '<|start_header_id|>assistant',
        tool: '<|start_header_id|>ipython'
      },
      role_templates: {
        user: '{user_message}',
        assistant: '{assistant_message}',
        tool: '{tool_message}'
      },
      seps: ['<|eot_id|>']
    }
  }),
  'conf.json': '{ "doit": "all" }',
  '1.bin': Buffer.from('first binary file'),
  '2.bin': Buffer.from('second binary file')
}

class FakeDL extends Base {
  async start () {}

  async stop () {}

  async list (path) {
    return [...Object.keys(files)]
  }

  async getStream (filepath) {
    const name = path.basename(filepath)
    return Readable.from(Buffer.from(files[name]))
  }
}

module.exports = FakeDL
