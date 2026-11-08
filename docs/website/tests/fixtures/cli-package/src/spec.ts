export async function renderSpec(): Promise<string> {
  return JSON.stringify({
    openapi: '3.1.0',
    paths: {
      '/v1/echo': {
        post: {
          summary: 'Echo a message',
          requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Echo' } } } },
          responses: { '200': { description: 'The message' } },
        },
      },
    },
    components: { schemas: { Echo: { type: 'object', properties: { message: { type: 'string', description: 'What to echo' } }, required: ['message'] } } },
  })
}
