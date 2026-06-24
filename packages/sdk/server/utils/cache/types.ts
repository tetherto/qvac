export interface CacheMessage {
  role: string;
  content: string;
  attachments?: { path: string }[] | undefined;
}
