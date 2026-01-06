'use strict'

const Base = require('@qvac/dl-base')
const path = require('bare-path')

const files = {
  'mlc-chat-config.json': JSON.stringify({
    context_window_size: 1024,
    prefill_chunk_size: 1024,
    temperature: 0.5,
    conv_template: {
      system_template: '<|start_header_id|>system<|end_header_id|>\n\n{system_message}<|eot_id|>',
      system_message: 'You are a helpful, respectful and honest assistant.',
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
      seps: ['<|eot_id|>'],
      role_content_sep: '<|end_header_id|>\n\n',
      role_empty_sep: '<|end_header_id|>\n\n'
    }
  }),
  'generation_config.json': JSON.stringify({
    temperature: 0.5,
    top_p: 0.9,
    max_tokens: 100,
    repetition_penalty: null
  }),
  'conf.json': '{ "doit": "all" }',
  '1.bin': Buffer.from('first binary file'),
  '2.bin': Buffer.from('second binary file')
}

class FakeDL extends Base {
  async start () { }

  async stop () { }

  async list (path) {
    return [...Object.keys(files)]
  }

  async getStream (filepath) {
    const name = path.basename(filepath)
    return Buffer.from(files[name])
  }
}

module.exports = FakeDL
