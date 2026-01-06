declare module "@qvac/dl-filesystem" {
  export interface FilesystemDLOptions {
    dirPath: string;
  }

  export default class FilesystemDL {
    constructor(opts: FilesystemDLOptions);

    ready(): Promise<void>;
    close(): Promise<void>;
    getStream(filePath: string): Promise<ReadableStream>;
    list(directoryPath?: string): Promise<string[]>;
  }
}
