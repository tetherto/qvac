export declare function echo(modelId: string, message: string): Promise<{ message: string }>

export declare function echoStream(
  modelId: string,
  message: string
): AsyncGenerator<{ chunk: string }>
