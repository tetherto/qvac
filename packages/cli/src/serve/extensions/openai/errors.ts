/**
 * Request-body fields of the OpenAI surface mapped to the `error.code` a
 * validation failure reports. Fields absent here fall back to
 * `invalid_request`.
 */
export const OPENAI_FIELD_CODES: Record<string, string> = {
  messages: 'missing_messages',
  input: 'missing_input',
  prompt: 'missing_prompt',
  file: 'missing_file',
  image: 'missing_image',
  'image[]': 'missing_image',
  query: 'missing_query',
  file_id: 'missing_file_id',
  voice: 'missing_voice',
  mask: 'mask_not_supported',
  size: 'invalid_size',
  seconds: 'invalid_seconds'
}
